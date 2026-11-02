// balance command — check unshielded + shielded balance via full wallet sync
// For positional address: unshielded only (GraphQL, no facade needed)

import { type ParsedArgs, getFlag, hasFlag, isMinimalMode } from '@kuiralabs/midnight-cli-core/lib/argv';
import { type NetworkName, isValidNetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import { saveShieldedAddress, findWalletByAddress } from '../lib/wallet-config.ts';
import { resolveSeedSource } from '../lib/seed-resolver.ts';
import { resolveNetwork } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { applyEndpointOverrides } from '@kuiralabs/midnight-cli-core/lib/network';
import { shieldedSyncEnabled, shieldedDisabledReason } from '@kuiralabs/midnight-cli-core/lib/shielded-policy';
import { isNativeToken } from '@kuiralabs/midnight-chain/lib/balance-subscription';
import { engineFor } from '@kuiralabs/midnight-cli-core/lib/engine';
import { assertLedgerSupported, fetchProtocolVersion } from '@kuiralabs/midnight-chain/lib/ledger-guard';
import { getChainGenesisHash } from '@kuiralabs/midnight-chain/lib/chain-id';
import { createEtaEstimator, formatSyncStatus } from '../lib/sync-eta.ts';
import { header, keyValue, divider, formatNight, formatAddress, toNight } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, dim } from '@kuiralabs/midnight-cli-core/ui/colors';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui/spinner';
import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';

export default async function balanceCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  // Positional address → unshielded only (lightweight, no facade)
  if (args.subcommand) {
    return addressBalance(args, ctx);
  }

  // Wallet-based → full sync, show both unshielded + shielded
  return walletBalance(args, ctx);
}

/**
 * Pull the network name out of a Bech32m address HRP. Addresses look like
 * `mn_addr_<network>1...` so we slice between the second underscore and the
 * `1` separator. Returns null when the format doesn't match a known network.
 */
function inferNetworkFromAddress(address: string): NetworkName | null {
  const match = address.match(/^mn_addr_([a-z]+)1/);
  if (!match) return null;
  const candidate = match[1];
  return isValidNetworkName(candidate) ? candidate : null;
}

// ── Positional address: unshielded only via GraphQL ──

async function addressBalance(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const address = args.subcommand!;
  ctx.diagnostics.line('balance', `address=${address}`);

  // Bech32m addresses encode the network in their HRP
  // (mn_addr_undeployed1..., mn_addr_preprod1..., mn_addr_preview1...).
  // When the caller didn't pass --network, infer from the address rather
  // than defaulting to whatever the config says — otherwise users hit a
  // confusing "expected HRP X, but was Y" error from the indexer.
  // When --network is explicit and disagrees with the HRP, fail loudly so
  // the mismatch surfaces at the CLI layer instead of as a GraphQL error.
  const inferredNetwork = inferNetworkFromAddress(address);
  const explicitNetwork = getFlag(args, 'network');
  if (explicitNetwork && inferredNetwork && explicitNetwork !== inferredNetwork) {
    throw new Error(
      `Address belongs to ${inferredNetwork} but --network is ${explicitNetwork}.\n` +
      `Drop --network (we'll infer from the address) or pass an address for ${explicitNetwork}.`
    );
  }
  if (!explicitNetwork && inferredNetwork) {
    args = { ...args, flags: { ...args.flags, network: inferredNetwork } };
  }

  const { name: networkName, config: networkConfig } = resolveNetwork({ args });

  // Shielded balances are private: reading one needs the wallet's secret key,
  // which an address alone doesn't carry. If this address belongs to one of our
  // wallets we have the seed → run the full wallet sync (which shows shielded).
  // Otherwise there's nothing to decrypt with → fail with a clear, actionable error.
  if (hasFlag(args, 'shielded')) {
    const owned = await findWalletByAddress(address);
    if (owned) {
      ctx.diagnostics.line('balance', `shielded positional → wallet ${owned.wallet.name} on ${owned.network}`);
      const delegated: ParsedArgs = {
        ...args,
        flags: { ...args.flags, wallet: owned.wallet.file, network: owned.network },
      };
      return walletBalance(delegated, ctx);
    }
    throw new Error(
      `Shielded balances are private — they can only be read with the wallet's secret key, ` +
      `not from an address alone.\n` +
      `This address isn't one of your wallets. Check its shielded balance from the wallet that owns it:\n` +
      `  midnight balance --wallet <name> --shielded --network ${networkName}`
    );
  }

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName);

  const spinner = ctx.progress.start(`Checking balance on ${networkName}...`);

  try {
    const result = await (await engineFor(networkName)).wallet.unshieldedBalance(address, networkConfig, {
      forceFresh: hasFlag(args, 'no-cache'),
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      onProgress: (current, highest) => {
        if (highest > 0) {
          const pct = Math.round((current / highest) * 100);
          spinner.update(`Syncing transactions... ${pct}%`);
        }
      },
    });

    spinner.stop(`Synced ${result.txCount} transactions`);

    if (hasFlag(args, 'json')) {
      const balances: Record<string, string> = {};
      for (const [tokenType, amount] of result.balances) {
        const key = isNativeToken(tokenType) ? 'NIGHT' : tokenType;
        balances[key] = isNativeToken(tokenType) ? toNight(amount) : amount.toString();
      }
      // Top-level NIGHT alias mirrors the nested balances.NIGHT for
      // consumers that read the flat shape (midnight-expert's session
      // health hook does jq '.balance // .NIGHT // "unknown"'). The
      // nested form remains the canonical source of truth.
      const nightAlias = balances.NIGHT !== undefined ? { NIGHT: balances.NIGHT } : {};
      // Slim drops the (long) address echo and txCount — agents already
      // know what they asked for, and txCount is an internal sync detail.
      if (isMinimalMode(args)) {
        ctx.output.result({ network: networkName, balances, ...nightAlias, utxoCount: result.utxoCount });
        return;
      }
      ctx.output.result({ address, network: networkName, balances, ...nightAlias, utxoCount: result.utxoCount, txCount: result.txCount });
      return;
    }

    if (result.balances.size === 0) {
      ctx.output.stdout('0\n');
    } else {
      for (const [tokenType, amount] of result.balances) {
        ctx.output.stdout(`${isNativeToken(tokenType) ? 'NIGHT' : tokenType}=${amount}\n`);
      }
    }

    ctx.output.stderr('\n' + header('Balance') + '\n\n');
    ctx.output.stderr(keyValue('Address', formatAddress(address)) + '\n');
    ctx.output.stderr(keyValue('Network', networkName) + '\n');
    ctx.output.stderr(keyValue('UTXOs', result.utxoCount.toString()) + '\n');
    ctx.output.stderr(keyValue('Transactions', result.txCount.toString()) + '\n');
    ctx.output.stderr('\n');

    if (result.balances.size === 0) {
      ctx.output.stderr(`  ${dim('No balance found')}\n`);
    } else {
      for (const [tokenType, amount] of result.balances) {
        if (isNativeToken(tokenType)) {
          ctx.output.stderr(keyValue('NIGHT', bold(formatNight(amount))) + '\n');
        } else {
          const shortType = tokenType.slice(0, 8) + '…' + tokenType.slice(-8);
          ctx.output.stderr(keyValue(`Token ${shortType}`, bold(amount.toString())) + '\n');
        }
      }
    }

    ctx.output.stderr('\n' + divider() + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}

// ── Wallet-based: full facade sync, both unshielded + shielded ──

async function walletBalance(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  ctx.diagnostics.line('balance', `network=${networkName} indexerWS=${networkConfig.indexerWS}`);
  // Seed source: --seed → MN_SEED → --wallet <name> → active wallet (shared resolver).
  const { seed: seedBuffer, walletPath, config } = await resolveSeedSource(args);
  ctx.diagnostics.line('balance', `wallet path=${walletPath ?? '(from --seed/MN_SEED)'}`);
  // Derive the unshielded address from the seed so a --seed/MN_SEED caller (no wallet
  // file) behaves identically to a named wallet — for a wallet this equals the stored one.
  const engine = await engineFor(networkName);
  const address = config?.addresses[networkName] ?? engine.keys.unshieldedAddress(seedBuffer, networkName);
  const shieldedAddrStr = config?.shieldedAddresses?.[networkName] ?? '';

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName);

  // Keep the SDK's transient errors and RPC noise off the terminal while this runs.
  const stopListening = ctx.sdkWarnings.listen(undefined);
  const noCache = hasFlag(args, 'no-cache');
  const isJson = hasFlag(args, 'json');
  const nightToken = engine.ledger.nightTokenId();

  let activeSpinner: Spinner | null = null;

  try {

    // Header + address chrome (we already have everything except live balances).
    if (!isJson) {
      ctx.output.stderr('\n' + header('Balance') + '\n\n');
      ctx.output.stderr(keyValue('Address', formatAddress(address)) + '\n');
      if (shieldedAddrStr) {
        ctx.output.stderr(keyValue('Shielded', formatAddress(shieldedAddrStr)) + '\n');
      }
      ctx.output.stderr(keyValue('Network', networkName) + '\n');
      ctx.output.stderr('\n  ' + bold('Unshielded') + '\n');
    }

    // ── Phase 1: fast unshielded via GraphQL (no facade, no proof server) ──
    if (!isJson) activeSpinner = ctx.progress.start('Checking unshielded...');
    ctx.diagnostics.line('balance', `phase=unshielded forceFresh=${noCache}`);
    const unshieldedResult = await (await engineFor(networkName)).wallet.unshieldedBalance(address, networkConfig, {
      forceFresh: noCache,
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      // Quiet by design — this finishes in <1s on most networks.
    });
    const unshieldedBalance = unshieldedResult.balances.get(nightToken) ?? 0n;
    const unshieldedUtxos = unshieldedResult.utxoCount;
    ctx.diagnostics.line('balance', `unshielded fromCache=${unshieldedResult.fromCache} utxos=${unshieldedUtxos} txs=${unshieldedResult.txCount}`);

    if (activeSpinner) {
      activeSpinner.stop('Unshielded ready');
      activeSpinner = null;
      if (unshieldedBalance > 0n) {
        ctx.output.stderr(keyValue('  NIGHT', bold(formatNight(unshieldedBalance))) + '\n');
        ctx.output.stderr(keyValue('  UTXOs', unshieldedUtxos.toString()) + '\n');
      } else {
        ctx.output.stderr(`    ${dim('No unshielded balance')}\n`);
      }
    }

    // Pipeable stdout for unshielded — emit immediately so consumers don't
    // have to wait for the shielded sync to read the unshielded value.
    if (!isJson) {
      ctx.output.stdout(`NIGHT=${unshieldedBalance}\n`);
      ctx.output.stderr('\n  ' + bold('Shielded') + '\n');
    }

    // ── Phase 2: shielded via facade sync (slower — needs ZK keys + WASM state) ──
    // Skipped where shielded is unusable (no faucet on preview/preprod) unless
    // --force-shielded is passed. This is the slow part of `mn balance`; skipping
    // it makes hosted-network balance checks near-instant.
    const shieldedEnabled = shieldedSyncEnabled(networkName, hasFlag(args, 'force-shielded'));
    let liveShieldedAddrStr = shieldedAddrStr;
    let shieldedBalance = 0n;
    let shieldedCoins = 0;
    let pendingCoins = 0;
    let shieldedTokens: ReadonlyMap<string, bigint> = new Map();

    if (shieldedEnabled) {
      if (!isJson) activeSpinner = ctx.progress.start('Syncing shielded...');
      const eta = createEtaEstimator();

      // Live shielded address is pure key derivation — no facade sync needed.
      liveShieldedAddrStr = engine.keys.shieldedAddress(seedBuffer, networkName);
      // Cache the shielded address only when there's a backing wallet file (skip for --seed/MN_SEED).
      if (walletPath) saveShieldedAddress(walletPath, networkName, liveShieldedAddrStr);

      // Shielded balance via the indexer-direct zswap-event reader + cache: it
      // replays `zswapLedgerEvents` with the full secret keys (reconciling
      // receives AND spends), replacing the facade's cold sync — ~50-70s first
      // time on hosted nets, incremental after, memory-bounded. chainId
      // invalidates the cache on chain reset.
      await assertLedgerSupported(networkName, networkConfig, fetchProtocolVersion, ctx.signal);
      // Null when the node can't say (the cache check is then skipped); a cancelled call stops here.
      const chainId = (await getChainGenesisHash(networkConfig.node, ctx.signal)) ?? undefined;
      const shieldedResult = await engine.readers.shieldedBalance(
        seedBuffer,
        networkName,
        networkConfig.indexerWS,
        {
          forceFresh: noCache,
          chainId,
          signal: ctx.signal,
          onProgress: (applied, highest) => {
            if (!activeSpinner) return;
            const snap = eta.sample({ applied, highest, t: Date.now() });
            activeSpinner.update(formatSyncStatus(snap, 'Syncing shielded'));
          },
        },
      );
      shieldedBalance = shieldedResult.balance;
      shieldedCoins = shieldedResult.availableCoins;
      shieldedTokens = shieldedResult.tokens;
      pendingCoins = 0; // confirmed chain state from events; no in-flight coins

      if (activeSpinner) {
        activeSpinner.stop('Shielded ready');
        activeSpinner = null;
        if (shieldedBalance > 0n) {
          ctx.output.stderr(keyValue('  NIGHT', bold(formatNight(shieldedBalance))) + '\n');
          ctx.output.stderr(keyValue('  Coins', `${shieldedCoins} available, ${pendingCoins} pending`) + '\n');
        }
        // Other tokens by their full raw type: what `mn swap` and transfers take.
        for (const [tokenType, amount] of shieldedTokens) {
          ctx.output.stderr(keyValue('  Token', `${bold(amount.toString())} ${dim(tokenType)}`) + '\n');
        }
        if (shieldedBalance === 0n && shieldedTokens.size === 0) {
          ctx.output.stderr(`    ${dim('No shielded balance')}\n`);
        }
      }
    } else if (!isJson) {
      ctx.output.stderr(`    ${dim('Skipped — ' + shieldedDisabledReason(networkName))}\n`);
    }

    if (isJson) {
      const tokens = Object.fromEntries([...shieldedTokens].map(([tokenType, amount]) => [tokenType, amount.toString()]));
      // Slim drops the unshielded + shielded address strings (~220 chars
      // combined). Agents already know which wallet they queried.
      // shieldedSynced=false means shielded was skipped (not a confirmed zero) —
      // consumers shouldn't read shielded.NIGHT as authoritative.
      if (isMinimalMode(args)) {
        ctx.output.result({
          network: networkName,
          unshielded: { NIGHT: toNight(unshieldedBalance), utxoCount: unshieldedUtxos },
          shielded: { NIGHT: toNight(shieldedBalance), availableCoins: shieldedCoins, pendingCoins, tokens },
          shieldedSynced: shieldedEnabled,
        });
        return;
      }
      ctx.output.result({
        address,
        shieldedAddress: liveShieldedAddrStr,
        network: networkName,
        unshielded: { NIGHT: toNight(unshieldedBalance), utxoCount: unshieldedUtxos },
        shielded: { NIGHT: toNight(shieldedBalance), availableCoins: shieldedCoins, pendingCoins, tokens },
        shieldedSynced: shieldedEnabled,
      });
      return;
    }

    // When shielded was skipped, say so on stdout too — `=0` would read as a
    // confirmed zero to a script parsing the pipeable output.
    ctx.output.stdout(`SHIELDED_NIGHT=${shieldedEnabled ? shieldedBalance : 'skipped'}\n`);
    for (const [tokenType, amount] of shieldedTokens) ctx.output.stdout(`SHIELDED_${tokenType}=${amount}\n`);
    ctx.output.stderr('\n' + divider() + '\n\n');
  } catch (err) {
    activeSpinner?.fail('Failed');
    throw err;
  } finally {
    stopListening();
  }
}
