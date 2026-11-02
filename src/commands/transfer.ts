// transfer command — send NIGHT from my wallet to another address
// Usage: midnight transfer <to> <amount> [--shielded]

import { throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';
import { type ParsedArgs, getFlag, hasFlag, rejectNoCacheForWrites } from '@kuiralabs/midnight-cli-core/lib/argv';
import { saveShieldedAddress, unlockWallet } from '../lib/wallet-config.ts';
import { resolveNetwork } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { applyEndpointOverrides } from '@kuiralabs/midnight-cli-core/lib/network';
import { resolveTransferRequest, type TransferRequest } from '../lib/transfer-request.ts';
import { engineFor } from '@kuiralabs/midnight-cli-core/lib/engine';
import { nightToMicro } from '@kuiralabs/midnight-cli-core/lib/amount';
import { header, keyValue, divider, formatAddress, successMessage } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, dim } from '@kuiralabs/midnight-cli-core/ui/colors';
import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';

export default async function transferCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  rejectNoCacheForWrites(args);
  const request = await resolveTransferRequest(args);
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
    const result = await (await engineFor(networkName)).wallet.transfer({
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

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName);

  ctx.output.stderr('\n' + header('Shielded Transfer') + '\n\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n');
  ctx.output.stderr(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  ctx.output.stderr(keyValue('Amount', bold(amountNight + ' NIGHT (shielded)')) + '\n');
  ctx.output.stderr('\n');


  // Keep the SDK's transient errors and RPC noise off the terminal while this runs.
  const stopListening = ctx.sdkWarnings.listen(undefined);
  const spinner = ctx.progress.start('Syncing wallet...');

  try {
    const txHash = await (await engineFor(networkName)).wallet.shieldedTransfer({
      seed: seedBuffer,
      network: networkName,
      networkConfig,
      recipient: recipientAddress,
      amount,
      progress: spinner,
      // Right after another payment the wallet's Dust can be short of this
      // fee: wait when the rest is moments away, else say how long it takes.
      waitForDustToCover: true,
      // Cache shielded address in wallet file
      onSenderShieldedAddress: (address) => saveShieldedAddress(walletPath, networkName, address),
      insufficient: (available) =>
        `Insufficient shielded balance: ${available} NIGHT available, ${amountNight} NIGHT requested.\n` +
        `Fund shielded balance: midnight airdrop ${amountNight} --shielded`,
      log: ctx.diagnostics.line,
      signal: ctx.signal,
      onStatus: (s) => spinner.update(s),
      onSyncProgress: (applied, highest) => {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
        }
      },
      onSyncDetail: (detail) => spinner.update(`Syncing wallet... (waiting on: ${detail})`),
    });

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
