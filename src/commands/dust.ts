// dust command — register UTXOs for dust generation, check status, export a snapshot
// Usage: midnight dust register | midnight dust status | midnight dust export


import { type ParsedArgs, getFlag, hasFlag, isMinimalMode, rejectNoCacheForWrites } from '@kuiralabs/midnight-cli-core/lib/argv';
import { UsageError, throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';
import { resolveWalletPath, unlockWallet } from '../lib/wallet-config.ts';
import { resolveSeed } from '../lib/seed-resolver.ts';
import { resolveNetwork } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { applyEndpointOverrides, type NetworkConfig, type NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import { checkBalance } from '@kuiralabs/midnight-chain/lib/balance-subscription';
import { engineFor } from '@kuiralabs/midnight-cli-core/lib/engine';
import { header, keyValue, divider, formatDust, successMessage, toDust } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, dim, yellow } from '@kuiralabs/midnight-cli-core/ui/colors';

import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';
import { type Receipt, receiptJson, receiptOf } from '@kuiralabs/midnight-chain/lib/tx-receipt';
import { receiptText } from '../ui/receipt.ts';

export default async function dustCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || (subcommand !== 'register' && subcommand !== 'status' && subcommand !== 'export')) {
    throw new UsageError(
      'Missing or invalid subcommand.\n' +
      'Usage:\n' +
      '  midnight dust register   Register NIGHT UTXOs for dust generation\n' +
      '  midnight dust status     Check dust registration status\n' +
      '  midnight dust export     Export a restorable dust snapshot (dustSerializedState)'
    );
  }

  // Resolve network first — independent of the wallet (--network flag / config / fallback).
  const root = ctx.config.paths.stateRoot;
  const { name: networkName, config: networkConfig } = resolveNetwork({ args, configDir: root });

  // Apply endpoint overrides: --flag > config > network default
  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName, root);

  const isJson = hasFlag(args, 'json');
  const minimal = isMinimalMode(args);

  // export: standalone path. Accepts a raw --seed (so a dApp operator can export a
  // snapshot for its own seed with no named wallet) or falls back to a named wallet.
  if (subcommand === 'export') {
    // The chain-id check connects to the node; keep polkadot-js's RPC-CORE noise off stderr.
    const stopListening = ctx.sdkWarnings.listen(undefined);
    try {
      await dustExport(await resolveSeed(args, root), networkName, networkConfig, isJson, minimal, ctx);
    } finally {
      stopListening();
    }
    return;
  }

  // status / register: named wallet + its stored address (used by the registration pre-check).
  const config = await unlockWallet(resolveWalletPath(root, getFlag(args, 'wallet')), { root });
  const seedBuffer = Buffer.from(config.seed, 'hex');
  const address = config.addresses[networkName];

  // status: pre-check registration via the indexer before paying for a full sync.
  // If the wallet isn't registered, no point doing anything else — return fast.
  if (subcommand === 'status') {
    const preCheck = await dustRegistrationPreCheck(
      address,
      networkName,
      networkConfig.indexerWS,
      ctx,
    );
    if (!preCheck.isRegistered) {
      printUnregisteredStatus(networkName, preCheck, isJson, minimal, ctx);
      return;
    }
    // Registered → read balance directly from indexer (bypasses the dust-wallet
    // SDK's `isConnected` hang). No facade needed for a read-only query.
    const useCache = !hasFlag(args, 'no-cache');
    await dustStatusDirect(seedBuffer, networkName, networkConfig, preCheck, isJson, minimal, useCache, ctx);
    return;
  }

  // register: full facade flow (requires proof server, keystore, sync).
  // The repo's withFacade owns: validate caches, pre-prime dust, build facade,
  // sync (with retry), save, invalidate, stop. We just provide the work.
  rejectNoCacheForWrites(args);
  await dustRegister(seedBuffer, networkName, networkConfig, isJson, ctx);
}

// export: fast dust-direct sync → emit a facade-restorable snapshot. The snapshot
// (the pipeable data) goes to stdout; a summary goes to stderr; --json bundles it all.
async function dustExport(
  seedBuffer: Buffer,
  networkName: NetworkName,
  networkConfig: NetworkConfig,
  jsonMode: boolean,
  minimal: boolean,
  ctx: CallContext,
): Promise<void> {
  const spinner = ctx.progress.start(`Reading dust events from ${networkName}...`);
  try {
    const result = await (await engineFor(networkName, ctx.config.paths.stateRoot)).wallet.exportDust(seedBuffer, networkName, networkConfig, {
      root: ctx.config.paths.stateRoot,
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      onProgress: (applied, maxIdSeen) => spinner.update(
        maxIdSeen > 0
          ? `Reading dust events... ${applied}/${maxIdSeen + 1}`
          : `Reading dust events... ${applied}`,
      ),
    });
    spinner.stop(
      result.partial
        ? 'Dust snapshot ready (incomplete)'
        : result.fromCache && result.eventCount === 0 ? 'Cache up to date' : 'Dust snapshot ready',
    );

    if (jsonMode) {
      ctx.output.result({
        subcommand: 'export',
        network: result.network,
        dustPublicKey: result.dustPublicKey,
        offset: result.offset,
        dustBalance: toDust(result.balance),
        eventCount: result.eventCount,
        fromCache: result.fromCache,
        partial: result.partial,
        snapshot: result.snapshot,
      });
      return;
    }

    ctx.output.stdout(result.snapshot + '\n');
    if (minimal) return;
    ctx.output.stderr('\n' + keyValue('Network', result.network) + '\n');
    ctx.output.stderr(keyValue('Dust balance', formatDust(result.balance)) + '\n');
    ctx.output.stderr(keyValue('Snapshot offset', String(result.offset)) + '\n');
    if (result.partial) {
      // Loud, because a partial snapshot restores without error and then quietly
      // hands the remaining events back to the SDK's cold sync — the exact failure
      // this command exists to prevent.
      ctx.output.stderr(
        '\n' + yellow(bold('⚠ Snapshot is INCOMPLETE — the sync did not reach the chain tip.')) + '\n' +
        dim('  Restoring it still beats a cold start, but the wallet has events left to catch up on.') + '\n' +
        dim('  Re-run `mn dust export` to resume from this checkpoint and finish.') + '\n',
      );
    }
    ctx.output.stderr('\n' + dim('Restore with the wallet SDK dustSerializedState to skip the cold dust sync.') + '\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}

interface PreCheckResult {
  isRegistered: boolean;
  registeredUtxos: number;
  unregisteredUtxos: number;
}

// Queries the indexer directly for UTXO registration metadata — no facade, no dust sync.
// Used to short-circuit `dust status` when the wallet has no registered UTXOs.
async function dustRegistrationPreCheck(
  address: string,
  networkName: string,
  indexerWS: string,
  ctx: CallContext,
): Promise<PreCheckResult> {
  ctx.output.stderr('\n' + header('Dust Status') + '\n\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n\n');

  const spinner = ctx.progress.start(`Checking registration on ${networkName}...`);

  try {
    const summary = await checkBalance(address, indexerWS, (current, highest) => {
      if (highest > 0) {
        const pct = Math.min(Math.round((current / highest) * 100), 100);
        spinner.update(pct >= 100 ? 'Checking registration...' : `Checking registration... ${pct}%`);
      }
    }, ctx.signal);

    throwIfCancelled(ctx.signal);

    const { registeredUtxos, unregisteredUtxos } = summary;
    spinner.stop('Registration checked');

    return {
      isRegistered: registeredUtxos > 0,
      registeredUtxos,
      unregisteredUtxos,
    };
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}

// Prints the "not registered" status and exits. Called only when registeredUtxos === 0.
function printUnregisteredStatus(
  networkName: string,
  preCheck: PreCheckResult,
  jsonMode: boolean,
  minimal: boolean,
  ctx: CallContext,
): void {
  const { registeredUtxos, unregisteredUtxos } = preCheck;
  const totalUtxos = registeredUtxos + unregisteredUtxos;

  if (jsonMode) {
    if (minimal) {
      ctx.output.result({
        network: networkName,
        registered: false,
        registeredUtxos,
        unregisteredUtxos,
      });
      return;
    }
    ctx.output.result({
      subcommand: 'status',
      registered: false,
      registeredUtxos,
      unregisteredUtxos,
      network: networkName,
    });
    return;
  }

  // Machine-readable to stdout
  ctx.output.stdout('registered=no\n');
  ctx.output.stdout(`registered_utxos=${registeredUtxos}\n`);
  ctx.output.stdout(`unregistered_utxos=${unregisteredUtxos}\n`);

  // Formatted to stderr
  ctx.output.stderr(keyValue('Registered', bold('no')) + '\n');
  ctx.output.stderr(keyValue('UTXOs', `${registeredUtxos} registered, ${unregisteredUtxos} unregistered`) + '\n');

  if (totalUtxos === 0) {
    ctx.output.stderr('\n' + dim('No NIGHT UTXOs at this address. Fund the wallet first.') + '\n');
  } else {
    ctx.output.stderr('\n' + dim('Not generating dust. Run: midnight dust register') + '\n');
  }

  ctx.output.stderr('\n' + divider() + '\n\n');
}

async function dustRegister(
  seedBuffer: Buffer,
  network: NetworkName,
  networkConfig: NetworkConfig,
  jsonMode: boolean,
  ctx: CallContext,
): Promise<void> {
  const networkName = networkConfig.networkId.toLowerCase();
  ctx.output.stderr('\n' + header('Dust Register') + '\n\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n\n');

  const spinner = ctx.progress.start('Syncing wallet...');

  try {
    const result = await (await engineFor(network, ctx.config.paths.stateRoot)).wallet.registerDust(seedBuffer, networkConfig, {
      root: ctx.config.paths.stateRoot,
      signal: ctx.signal,
      sdkWarnings: ctx.sdkWarnings,
      log: ctx.diagnostics.line,
      onStatus: (s) => spinner.update(s),
      onSyncProgress: (applied, highest) => {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
        }
      },
      onSyncDetail: (detail) => spinner.update(`Syncing wallet... (waiting on: ${detail})`),
      onSyncWarning: (_tag, msg) => spinner.update(`Syncing wallet... (${msg}, retrying)`),
    });
    const dustBal = result.dustBalance;
    let receipt: Receipt | undefined;
    if (result.txHash) {
      spinner.update('Waiting for the indexer to list it...');
      receipt = await receiptOf(networkConfig.indexer, result.txHash, ctx.signal);
    }

    spinner.stop(result.alreadyAvailable ? 'Dust already available' : 'Dust registration complete');

    if (jsonMode) {
      const json: Record<string, unknown> = { subcommand: 'register', dustBalance: toDust(dustBal) };
      if (result.txHash) json.txHash = result.txHash;
      if (receipt) Object.assign(json, receiptJson(receipt));
      ctx.output.result(json);
      return;
    }

    ctx.output.stdout(dustBal.toString() + '\n');
    ctx.output.stderr('\n' + successMessage(
      result.alreadyAvailable
        ? `Dust tokens already available: ${formatDust(dustBal)}`
        : `Dust tokens available: ${formatDust(dustBal)}`,
    ) + '\n');
    ctx.output.stderr((receipt && result.txHash ? receiptText(receipt, result.txHash) : '') + '\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}

// Registered-status path: indexer-direct dust read via the wallet data
// repository. Repo handles cache load/save, in-memory memo, tip-aware
// invalidation, and force-fresh — see lib/wallet-data-repository.ts.
async function dustStatusDirect(
  seedBuffer: Buffer,
  network: NetworkName,
  networkConfig: NetworkConfig,
  preCheck: PreCheckResult,
  jsonMode: boolean,
  minimal: boolean,
  useCache: boolean,
  ctx: CallContext,
): Promise<void> {
  const networkName = networkConfig.networkId.toLowerCase();
  const spinner = ctx.progress.start(`Reading dust events from ${networkName}...`);

  try {
    const view = await (await engineFor(network, ctx.config.paths.stateRoot)).wallet.dustBalance(seedBuffer, networkConfig, {
      root: ctx.config.paths.stateRoot,
      forceFresh: !useCache,
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      onStatus: (msg) => spinner.update(msg),
    });

    spinner.stop(view.fromCache && view.eventsApplied === 0 ? 'Cache up to date' : 'Dust events applied');

    const { registeredUtxos, unregisteredUtxos } = preCheck;

    if (jsonMode) {
      // Slim drops eventsApplied/ownedUtxos/cached/subcommand — internal
      // sync details an agent doesn't need to act on.
      if (minimal) {
        ctx.output.result({
          network: networkName,
          registered: true,
          registeredUtxos,
          unregisteredUtxos,
          dustBalance: toDust(view.balance),
          dustAvailable: view.availableCoins > 0,
        });
        return;
      }
      ctx.output.result({
        subcommand: 'status',
        registered: true,
        registeredUtxos,
        unregisteredUtxos,
        dustBalance: toDust(view.balance),
        dustAvailable: view.availableCoins > 0,
        eventsApplied: view.eventsApplied,
        ownedUtxos: view.ownedUtxoCount,
        cached: view.fromCache,
        network: networkName,
      });
      return;
    }

    // Machine-readable to stdout
    ctx.output.stdout('registered=yes\n');
    ctx.output.stdout(`dust=${view.balance}\n`);
    ctx.output.stdout(`registered_utxos=${registeredUtxos}\n`);
    ctx.output.stdout(`unregistered_utxos=${unregisteredUtxos}\n`);

    // Formatted to stderr
    ctx.output.stderr(keyValue('Registered', bold('yes')) + '\n');
    ctx.output.stderr(keyValue('UTXOs', `${registeredUtxos} registered, ${unregisteredUtxos} unregistered`) + '\n');
    ctx.output.stderr(keyValue('Dust Balance', bold(formatDust(view.balance))) + '\n');
    ctx.output.stderr(keyValue('Dust Available', view.availableCoins > 0 ? 'yes' : 'no') + '\n');
    ctx.output.stderr(keyValue('Events applied', view.eventsApplied.toString() + (view.fromCache ? ' (delta)' : '')) + '\n');
    if (unregisteredUtxos > 0) {
      ctx.output.stderr('\n' + dim(`${unregisteredUtxos} UTXO(s) not yet registered. Run: midnight dust register`) + '\n');
    }
    ctx.output.stderr('\n' + divider() + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}
