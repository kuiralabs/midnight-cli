// transfer command — send NIGHT from my wallet to another address
// Usage: midnight transfer <to> <amount> [--shielded]

import * as ledger from '@midnightntwrk/ledger-v9';
import { CANCELLED_MESSAGE } from '../lib/errors.ts';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk/address-format';
import { type ParsedArgs, getFlag, hasFlag, rejectNoCacheForWrites } from '../lib/argv.ts';
import { saveShieldedAddress, unlockWallet } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides } from '../lib/network.ts';
import { getNetworkId } from '../lib/network-id.ts';
import { resolveTransferRequest, decodeShieldedRecipient, type TransferRequest } from '../lib/transfer-request.ts';
import { executeTransfer, ensureDust } from '../lib/transfer.ts';
import { nightToMicro } from '../lib/amount.ts';
import { defaultRepository } from '../lib/wallet-data-repository.ts';
import { header, keyValue, divider, formatAddress, successMessage } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { trackElapsed } from '../ui/spinner.ts';
import type { CallContext } from '../lib/call-context.ts';
import { DUST_SHORT_WAIT_MS, payWhenDustCovers } from '../lib/dust-wait.ts';

export default async function transferCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  rejectNoCacheForWrites(args);
  const request = resolveTransferRequest(args);
  return request.shielded ? shieldedTransfer(args, request, ctx) : unshieldedTransfer(args, request, ctx);
}

// ── Unshielded transfer (existing flow) ──

async function unshieldedTransfer(
  args: ParsedArgs,
  { walletPath, walletConfig: config, recipientAddress, amountNight }: TransferRequest,
  ctx: CallContext,
): Promise<void> {
  const seedBuffer = Buffer.from((await unlockWallet(walletPath)).seed, 'hex');

  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  const address = config.addresses[networkName];

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName);

  ctx.output.stderr('\n' + header('Transfer') + '\n\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n');
  ctx.output.stderr(keyValue('From', formatAddress(address, true)) + '\n');
  ctx.output.stderr(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  ctx.output.stderr(keyValue('Amount', bold(amountNight + ' NIGHT')) + '\n');
  ctx.output.stderr('\n');

  const spinner = ctx.progress.start('Starting wallet...');

  try {
    const result = await executeTransfer({
      seedBuffer,
      networkConfig,
      recipientAddress,
      amountNight,
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      sdkWarnings: ctx.sdkWarnings,
      onSync(applied, highest) {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
        }
      },
      onSyncDetail(detail) {
        spinner.update(`Syncing wallet... (waiting on: ${detail})`);
      },
      onDust(status) {
        spinner.update(`Dust: ${status}`);
      },
      onProving() {
        spinner.update('Generating ZK proof (this may take a few minutes)...');
      },
      onSubmitting() {
        spinner.update('Submitting and waiting for finalization (typically 12 to 30s)...');
      },
      onSubmittingTick(elapsedMs: number) {
        const s = Math.floor(elapsedMs / 1000);
        const mm = Math.floor(s / 60).toString().padStart(2, '0');
        const ss = (s % 60).toString().padStart(2, '0');
        spinner.update(`Submitting and waiting for finalization... ${mm}:${ss} elapsed (typically 12 to 30s)`);
      },
      onSyncWarning(_tag, msg) {
        spinner.update(`Syncing wallet... (${msg}, retrying)`);
      },
    });

    spinner.stop('Transaction submitted');

    if (hasFlag(args, 'json')) {
      ctx.output.result({
        txHash: result.txHash,
        amount: amountNight,
        recipient: recipientAddress,
        network: networkName,
      });
      return;
    }

    ctx.output.stdout(result.txHash + '\n');

    ctx.output.stderr('\n' + successMessage(
      `Transferred ${amountNight} NIGHT`,
      result.txHash,
    ) + '\n');
    ctx.output.stderr('\n' + divider() + '\n');
    ctx.output.stderr(dim('  Verify: midnight balance') + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}

// ── Shielded transfer ──

async function shieldedTransfer(
  args: ParsedArgs,
  { walletPath, walletConfig: config, recipientAddress, amountNight }: TransferRequest,
  ctx: CallContext,
): Promise<void> {
  const amount = nightToMicro(amountNight);
  const seedBuffer = Buffer.from((await unlockWallet(walletPath)).seed, 'hex');

  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  const networkId = getNetworkId(networkConfig.networkId);
  const nightToken = ledger.unshieldedToken().raw;

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName);

  const decodedRecipient = decodeShieldedRecipient(recipientAddress, networkName);

  ctx.output.stderr('\n' + header('Shielded Transfer') + '\n\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n');
  ctx.output.stderr(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  ctx.output.stderr(keyValue('Amount', bold(amountNight + ' NIGHT (shielded)')) + '\n');
  ctx.output.stderr('\n');


  // Keep the SDK's transient errors and RPC noise off the terminal while this runs.
  const stopListening = ctx.sdkWarnings.listen(undefined);
  const spinner = ctx.progress.start('Syncing wallet...');

  try {
    const txHash = await defaultRepository().withFacade(
      seedBuffer,
      networkConfig,
      async ({ bundle, state }) => {
        // Cache shielded address in wallet file
        const senderShieldedAddr = MidnightBech32m.encode(networkId, state.shielded.address).asString();
        saveShieldedAddress(walletPath, networkName, senderShieldedAddr);

        const shieldedBalance = state.shielded.balances[nightToken] ?? 0n;
        if (shieldedBalance < amount) {
          const available = Number(shieldedBalance) / 1_000_000;
          throw new Error(
            `Insufficient shielded balance: ${available.toFixed(6)} NIGHT available, ${amountNight} NIGHT requested.\n` +
            `Fund shielded balance: midnight airdrop ${amountNight} --shielded`
          );
        }

        spinner.update('Checking dust...');
        await ensureDust(bundle, (status: string) => spinner.update(status));

        if (ctx.signal.aborted) throw new Error(CANCELLED_MESSAGE);

        spinner.update('Building shielded transaction...');
        // Right after another payment the wallet's Dust can be short of this
        // fee: wait when the rest is moments away, else say how long it takes.
        const recipe = await payWhenDustCovers(
          () => bundle.facade.transferTransaction(
            [{
              type: 'shielded' as const,
              outputs: [{ type: nightToken, amount, receiverAddress: decodedRecipient }],
            }],
            { ttl: new Date(Date.now() + 60 * 60 * 1000) },
          ),
          state.dust,
          { maxWaitMs: DUST_SHORT_WAIT_MS, onStatus: (status) => spinner.update(status), signal: ctx.signal },
        );

        spinner.update('Signing...');
        const signed = await bundle.facade.signRecipe(
          recipe,
          bundle.keystore.signDataAsync,
        );

        spinner.update('Generating ZK proof (this may take a few minutes)...');
        const finalized = await bundle.facade.finalizeRecipe(signed);

        const txId = await trackElapsed(
          spinner,
          'Submitting and waiting for finalization (typically 12 to 30s)...',
          bundle.facade.submitTransaction(finalized),
        );
        return String(txId);
      },
      {
        syncMode: 'full',
        log: ctx.diagnostics.line,
        requireStrictSync: true,
        signal: ctx.signal,
        onStatus: (s) => spinner.update(s),
        onSyncProgress: (applied, highest) => {
          if (highest > 0) {
            const pct = Math.min(Math.round((applied / highest) * 100), 100);
            spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
          }
        },
        onSyncDetail: (detail) => spinner.update(`Syncing wallet... (waiting on: ${detail})`),
      },
    );

    spinner.stop('Transaction submitted');

    if (hasFlag(args, 'json')) {
      ctx.output.result({ txHash, amount: amountNight, recipient: recipientAddress, network: networkName, type: 'shielded' });
      return;
    }
    ctx.output.stdout(txHash + '\n');
    ctx.output.stderr('\n' + successMessage(`Transferred ${amountNight} shielded NIGHT`, txHash) + '\n');
    ctx.output.stderr('\n' + divider() + '\n');
    ctx.output.stderr(dim('  Verify: midnight balance --shielded') + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  } finally {
    stopListening();
  }
}
