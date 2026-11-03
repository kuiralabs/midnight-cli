// airdrop command — fund wallet from genesis wallet (seed 0x01)
// Only works on undeployed network (local devnet)
// --shielded: sends shielded NIGHT from genesis shielded balance
//
// `--wallet` accepts three forms:
//   1. a wallet name (resolved from ~/.midnight/wallets/<name>.json)
//   2. a path to a wallet JSON
//   3. a raw bech32m address (mn_addr_… or mn_shield-addr_…) — no wallet
//      file required, useful for funding externally-generated addresses.
//      A shielded address implies --shielded; the flag is optional there.

import { throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';
import { type ParsedArgs, getFlag, hasFlag, rejectNoCacheForWrites } from '@kuiralabs/midnight-cli-core/lib/argv';
import { resolveWalletPath, saveShieldedAddress, walletAddress, walletShieldedAddress } from '../lib/wallet-config.ts';
import { resolveNetwork } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { applyEndpointOverrides, type NetworkConfig, type NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import { GENESIS_SEED } from '@kuiralabs/midnight-cli-core/lib/constants';
import { engineFor } from '@kuiralabs/midnight-cli-core/lib/engine';
import { parseAmount, nightToMicro } from '@kuiralabs/midnight-cli-core/lib/amount';
import { header, keyValue, divider, formatAddress, successMessage } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, dim } from '@kuiralabs/midnight-cli-core/ui/colors';
import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';
import { receiptJson, receiptOf } from '@kuiralabs/midnight-chain/lib/tx-receipt';
import { receiptText } from '../ui/receipt.ts';

export default async function airdropCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  rejectNoCacheForWrites(args);
  const amountStr = args.subcommand;
  if (!amountStr) {
    throw new Error(
      'Missing amount.\n' +
      'Usage: midnight airdrop <amount> [--wallet <name|file|address>]\n' +
      'Example: midnight airdrop 1000\n' +
      'Example: midnight airdrop 1000 --wallet alice\n' +
      'Example: midnight airdrop 1000 --wallet mn_addr_undeployed1...'
    );
  }

  const amountNight = parseAmount(amountStr);
  const { name: networkName, config: networkConfig } = resolveNetwork({ args });

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName);

  if (networkName !== 'undeployed') {
    throw new Error(
      `Airdrop is only available on the "undeployed" network (local devnet).\n` +
      `Current network: "${networkName}"\n` +
      `On preprod/preview, use a faucet or transfer from another wallet.`
    );
  }

  // A shielded address prefix is unambiguous — infer --shielded instead of
  // making the user repeat what the address already says. The reverse
  // (--shielded with an unshielded address) stays an error: that's a real
  // contradiction, resolved in resolveAddressDestination.
  const walletFlag = getFlag(args, 'wallet');
  const isShielded = hasFlag(args, 'shielded') ||
    (walletFlag !== undefined && walletFlag.startsWith('mn_shield-addr_'));
  const destination = await resolveDestination(args, networkName, networkConfig, isShielded);

  if (isShielded) {
    return shieldedAirdrop(args, destination as ShieldedDestination, amountNight, networkName, networkConfig, ctx);
  }

  return unshieldedAirdrop(args, destination as UnshieldedDestination, amountNight, networkName, networkConfig, ctx);
}

// ── Destination resolution ──
//
// `--wallet` accepts a name, a file path, or a raw bech32m address.
// Resolution is uniform for the entry point; the helpers receive a
// pre-resolved destination so they don't reach back into wallet files
// when funding an external address.

type UnshieldedDestination = { kind: 'address'; address: string };

type ShieldedDestination =
  | { kind: 'address'; bech32m: string }
  | { kind: 'wallet'; bech32m: string; walletPath: string };

function looksLikeBech32mAddress(value: string): boolean {
  return value.startsWith('mn_addr_') || value.startsWith('mn_shield-addr_');
}

async function resolveDestination(
  args: ParsedArgs,
  networkName: NetworkName,
  networkConfig: NetworkConfig,
  isShielded: boolean,
): Promise<UnshieldedDestination | ShieldedDestination> {
  const walletFlag = getFlag(args, 'wallet');

  if (walletFlag !== undefined && looksLikeBech32mAddress(walletFlag)) {
    return resolveAddressDestination(walletFlag, networkName, isShielded);
  }

  // Fall back to wallet file (name, path, or active wallet)
  const walletPath = resolveWalletPath(walletFlag);

  if (isShielded) {
    // The wallet's own shielded address, as its file keeps it: receiving needs no passphrase
    // (unless the network was added after the wallet was written).
    const stored = await walletShieldedAddress(walletPath, networkName);
    if (stored === undefined) throw new Error(`Wallet ${walletPath} keeps no shielded address for ${networkName}.`);
    const decoded = await resolveAddressDestination(stored, networkName, true) as ShieldedDestination;
    return { kind: 'wallet', bech32m: decoded.bech32m, walletPath };
  }

  return { kind: 'address', address: await walletAddress(walletPath, networkName) };
}

async function resolveAddressDestination(
  address: string,
  networkName: NetworkName,
  isShielded: boolean,
): Promise<UnshieldedDestination | ShieldedDestination> {
  const looksShielded = address.startsWith('mn_shield-addr_');

  // The inverse mismatch (shielded address without --shielded) never
  // reaches here: the entry point infers --shielded from the prefix.
  if (isShielded && !looksShielded) {
    throw new Error(
      `--shielded was passed but --wallet is an unshielded address.\n` +
      `Pass a shielded address (mn_shield-addr_...) or drop --shielded.\n` +
      `Got: ${address}`
    );
  }

  const expectedPrefix = isShielded
    ? `mn_shield-addr_${networkName}1`
    : `mn_addr_${networkName}1`;

  if (!address.startsWith(expectedPrefix)) {
    throw new Error(
      `Address does not match network "${networkName}".\n` +
      `Expected prefix: ${expectedPrefix}\n` +
      `Got: ${address}`
    );
  }

  if (isShielded) {
    try {
      (await engineFor(networkName)).keys.assertAddress(address, 'shielded', networkName);
    } catch (err: any) {
      throw new Error(`Invalid shielded address: ${err.message}`);
    }
    return { kind: 'address', bech32m: address };
  }

  return { kind: 'address', address };
}

// ── Unshielded airdrop (existing flow) ──

async function unshieldedAirdrop(
  args: ParsedArgs,
  destination: UnshieldedDestination,
  amountNight: number,
  networkName: NetworkName,
  networkConfig: NetworkConfig,
  ctx: CallContext,
): Promise<void> {
  const recipientAddress = destination.address;

  ctx.output.stderr('\n' + header('Airdrop') + '\n\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n');
  ctx.output.stderr(keyValue('From', dim('genesis (seed 0x01)')) + '\n');
  ctx.output.stderr(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  ctx.output.stderr(keyValue('Amount', bold(amountNight + ' NIGHT')) + '\n');
  ctx.output.stderr('\n');

  const spinner = ctx.progress.start('Starting genesis wallet...');

  try {
    const result = await (await engineFor(networkName)).wallet.airdrop({
      networkConfig,
      recipientAddress,
      amountNight,
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      sdkWarnings: ctx.sdkWarnings,
      onSync(applied, highest) {
        if (highest > 0) {
          const pct = Math.round((applied / highest) * 100);
          spinner.update(`Syncing genesis wallet... ${pct}%`);
        }
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
        spinner.update(`Syncing genesis wallet... (${msg}, retrying)`);
      },
    });

    spinner.update('Waiting for the indexer to list it...');
    const receipt = await receiptOf(networkConfig.indexer, result.txHash, ctx.signal);
    spinner.stop('Transaction submitted');

    if (hasFlag(args, 'json')) {
      ctx.output.result({
        txHash: result.txHash,
        amount: amountNight,
        recipient: recipientAddress,
        network: networkName,
        ...receiptJson(receipt),
      });
      return;
    }

    ctx.output.stdout(result.txHash + '\n');

    ctx.output.stderr('\n' + successMessage(
      `Airdropped ${amountNight} NIGHT to your wallet`,
      result.txHash,
    ) + '\n');
    ctx.output.stderr(receiptText(receipt, result.txHash));
    ctx.output.stderr('\n' + divider() + '\n');
    ctx.output.stderr(dim('  Verify:         midnight balance') + '\n');
    ctx.output.stderr(dim('  Register dust:  midnight dust register') + '\n');
    ctx.output.stderr(dim('  Note: registering pays its fee from Dust this NIGHT generates, so it waits longer the less NIGHT')
      + '\n' + dim('        there is (about a minute for 1000 NIGHT). dust register says how long.') + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}

// ── Shielded airdrop (genesis shielded → user shielded) ──

async function shieldedAirdrop(
  args: ParsedArgs,
  destination: ShieldedDestination,
  amountNight: number,
  networkName: NetworkName,
  networkConfig: NetworkConfig,
  ctx: CallContext,
): Promise<void> {
  const amount = nightToMicro(amountNight);

  const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');

  const userShieldedAddrStr = destination.bech32m;
  // Cache the shielded address into the wallet file so subsequent reads
  // can short-circuit. Only meaningful when the destination came from a
  // managed wallet — for a raw address there's nothing to cache.
  if (destination.kind === 'wallet') {
    saveShieldedAddress(destination.walletPath, networkName, userShieldedAddrStr);
  }

  ctx.output.stderr('\n' + header('Shielded Airdrop') + '\n\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n');
  ctx.output.stderr(keyValue('From', dim('genesis shielded (seed 0x01)')) + '\n');
  ctx.output.stderr(keyValue('To', formatAddress(userShieldedAddrStr, true)) + '\n');
  ctx.output.stderr(keyValue('Amount', bold(amountNight + ' NIGHT (shielded)')) + '\n');
  ctx.output.stderr('\n');

  // Keep the SDK's transient errors and RPC noise off the terminal while this runs.
  const stopListening = ctx.sdkWarnings.listen(undefined);
  const spinner = ctx.progress.start('Syncing genesis wallet...');

  try {
    const txHash = await (await engineFor(networkName)).wallet.shieldedTransfer({
      seed: genesisSeedBuffer,
      network: networkName,
      networkConfig,
      recipient: userShieldedAddrStr,
      amount,
      progress: spinner,
      waitForDustToCover: false,
      insufficient: (available) =>
        `Genesis wallet has insufficient shielded balance: ${available} NIGHT available, ${amountNight} NIGHT requested`,
      log: ctx.diagnostics.line,
      signal: ctx.signal,
      onStatus: (s) => spinner.update(s),
      onSyncProgress: (applied, highest) => {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          spinner.update(pct >= 100 ? 'Syncing genesis wallet...' : `Syncing genesis wallet... ${pct}%`);
        }
      },
      onSyncDetail: (detail) => spinner.update(`Syncing genesis wallet... (waiting on: ${detail})`),
    });

    spinner.update('Waiting for the indexer to list it...');
    const receipt = await receiptOf(networkConfig.indexer, txHash, ctx.signal);
    spinner.stop('Transaction submitted');

    if (hasFlag(args, 'json')) {
      ctx.output.result({ txHash, amount: amountNight, shieldedAddress: userShieldedAddrStr, network: networkName, type: 'shielded', ...receiptJson(receipt) });
      return;
    }
    ctx.output.stdout(txHash + '\n');
    ctx.output.stderr('\n' + successMessage(`Airdropped ${amountNight} shielded NIGHT to your wallet`, txHash) + '\n');
    ctx.output.stderr(receiptText(receipt, txHash));
    ctx.output.stderr('\n' + divider() + '\n');
    ctx.output.stderr(dim('  Verify: midnight balance --shielded') + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  } finally {
    stopListening();
  }
}
