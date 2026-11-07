// balance command — check unshielded + shielded balance via full wallet sync
// For positional address: unshielded only (GraphQL, no facade)

import { type ParsedArgs, hasFlag, isMinimalMode, isNamedOnlyNetwork, networkChoiceFromArgs, networkTargetOf, NetworkNotNamedError, shieldedDisabledReason, type CallContext, UsageError } from '@kuiralabs/midnight-cli-core';
import { header, keyValue, divider, formatNight, formatAddress, toNight, bold, dim, spinnerReporter } from '@kuiralabs/midnight-cli-core/ui';
import { findWalletByAddress } from '../lib/wallet-config.ts';
import { walletSourceOf } from '../lib/seed-resolver.ts';
import { isNativeToken } from '@kuiralabs/midnight-chain';
import { addressNetwork, readAddressBalance, readWalletBalance } from '../lib/wallet/balance.ts';

export default async function balanceCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  // Positional address → unshielded only (lightweight, no facade)
  if (args.subcommand) {
    return addressBalance(args, ctx);
  }

  // Wallet-based → full sync, show both unshielded + shielded
  return walletBalance(args, ctx);
}

// ── Positional address: unshielded only via GraphQL ──

async function addressBalance(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const address = args.subcommand!;
  if (args.positionals.length > 0) {
    throw new UsageError(`balance takes one address; also given: ${args.positionals.join(' ')}\nUsage: midnight balance [address]`);
  }
  ctx.diagnostics.line('balance', `address=${address}`);
  const choice = networkChoiceFromArgs(args);

  // Shielded balances are private: reading one needs the wallet's secret key,
  // which an address alone doesn't carry. If this address belongs to one of our
  // wallets we have the seed → run the full wallet sync (which shows shielded).
  // Otherwise there's nothing to decrypt with → fail with a clear, actionable error.
  if (hasFlag(args, 'shielded')) {
    const { network: networkName, root } = networkTargetOf(ctx.host, { ...choice, network: addressNetwork(address, choice.network) });
    const owned = await findWalletByAddress(root, address, ctx.host.engines);
    if (owned) {
      // The owning wallet's network is inferred from the address: never one a command must name.
      if (isNamedOnlyNetwork(owned.network) && choice.network !== owned.network) {
        throw new NetworkNotNamedError(owned.network, `${address} is wallet ${owned.wallet.name}'s ${owned.network} address, and the command didn't name ${owned.network}`);
      }
      ctx.diagnostics.line('balance', `shielded positional → wallet ${owned.wallet.name} on ${owned.network}`);
      const delegated: ParsedArgs = {
        ...args,
        flags: { ...args.flags, wallet: owned.wallet.file, network: owned.network },
      };
      return walletBalance(delegated, ctx);
    }
    throw new UsageError(
      `Shielded balances are private — they can only be read with the wallet's secret key, ` +
      `not from an address alone.\n` +
      `This address isn't one of your wallets. Check its shielded balance from the wallet that owns it:\n` +
      `  midnight balance --wallet <name> --shielded --network ${networkName}`
    );
  }

  // --json shows no step on the terminal.
  const progress = spinnerReporter(ctx.progress, hasFlag(args, 'json'));
  try {
    const result = await readAddressBalance(ctx.host, address, {
      ...choice,
      forceFresh: hasFlag(args, 'no-cache'),
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      onProgress: progress.report,
    });
    const networkName = result.network;

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
    progress.fail('Failed');
    throw err;
  }
}

// ── Wallet-based: full facade sync, both unshielded + shielded ──

async function walletBalance(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const isJson = hasFlag(args, 'json');
  // --json shows no step on the terminal.
  const progress = spinnerReporter(ctx.progress, isJson);

  try {
    const result = await readWalletBalance(ctx.host, walletSourceOf(args, ctx.config.settings), {
      ...networkChoiceFromArgs(args),
      forceFresh: hasFlag(args, 'no-cache'),
      forceShielded: hasFlag(args, 'force-shielded'),
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      sdkWarnings: ctx.sdkWarnings,
      onProgress: (event) => {
        if (event.kind === 'wallet-opened') {
          // Header + address chrome (everything but the balances, which follow as they are read).
          if (isJson) return;
          ctx.output.stderr('\n' + header('Balance') + '\n\n');
          ctx.output.stderr(keyValue('Address', formatAddress(event.address)) + '\n');
          if (event.shieldedAddress) {
            ctx.output.stderr(keyValue('Shielded', formatAddress(event.shieldedAddress)) + '\n');
          }
          ctx.output.stderr(keyValue('Network', event.network) + '\n');
          ctx.output.stderr('\n  ' + bold('Unshielded') + '\n');
        } else if (event.kind === 'unshielded-read') {
          if (isJson) return;
          if (event.night > 0n) {
            ctx.output.stderr(keyValue('  NIGHT', bold(formatNight(event.night))) + '\n');
            ctx.output.stderr(keyValue('  UTXOs', event.utxoCount.toString()) + '\n');
          } else {
            ctx.output.stderr(`    ${dim('No unshielded balance')}\n`);
          }
          // Pipeable stdout for unshielded — emit immediately so consumers don't
          // have to wait for the shielded sync to read the unshielded value.
          ctx.output.stdout(`NIGHT=${event.night}\n`);
          ctx.output.stderr('\n  ' + bold('Shielded') + '\n');
        } else {
          progress.report(event);
        }
      },
    });

    const { network: networkName, unshielded, shielded } = result;
    const shieldedNight = shielded?.night ?? 0n;
    const shieldedCoins = shielded?.availableCoins ?? 0;
    // Confirmed chain state from events: no coins in flight.
    const pendingCoins = 0;
    const shieldedTokens: ReadonlyMap<string, bigint> = shielded?.tokens ?? new Map();

    if (isJson) {
      const tokens = Object.fromEntries([...shieldedTokens].map(([tokenType, amount]) => [tokenType, amount.toString()]));
      // Slim drops the unshielded + shielded address strings (~220 chars
      // combined). Agents already know which wallet they queried.
      // shieldedSynced=false means shielded was skipped (not a confirmed zero) —
      // consumers shouldn't read shielded.NIGHT as authoritative.
      if (isMinimalMode(args)) {
        ctx.output.result({
          network: networkName,
          unshielded: { NIGHT: toNight(unshielded.night), utxoCount: unshielded.utxoCount },
          shielded: { NIGHT: toNight(shieldedNight), availableCoins: shieldedCoins, pendingCoins, tokens },
          shieldedSynced: shielded !== null,
        });
        return;
      }
      ctx.output.result({
        address: result.address,
        shieldedAddress: result.shieldedAddress ?? '',
        network: networkName,
        unshielded: { NIGHT: toNight(unshielded.night), utxoCount: unshielded.utxoCount },
        shielded: { NIGHT: toNight(shieldedNight), availableCoins: shieldedCoins, pendingCoins, tokens },
        shieldedSynced: shielded !== null,
      });
      return;
    }

    if (shielded !== null) {
      if (shieldedNight > 0n) {
        ctx.output.stderr(keyValue('  NIGHT', bold(formatNight(shieldedNight))) + '\n');
        ctx.output.stderr(keyValue('  Coins', `${shieldedCoins} available, ${pendingCoins} pending`) + '\n');
      }
      // Other tokens by their full raw type: what `mn swap` and transfers take.
      for (const [tokenType, amount] of shieldedTokens) {
        ctx.output.stderr(keyValue('  Token', `${bold(amount.toString())} ${dim(tokenType)}`) + '\n');
      }
      if (shieldedNight === 0n && shieldedTokens.size === 0) {
        ctx.output.stderr(`    ${dim('No shielded balance')}\n`);
      }
    } else {
      ctx.output.stderr(`    ${dim('Skipped — ' + shieldedDisabledReason(networkName))}\n`);
    }

    // When shielded was skipped, say so on stdout too — `=0` would read as a
    // confirmed zero to a script parsing the pipeable output.
    ctx.output.stdout(`SHIELDED_NIGHT=${shielded !== null ? shieldedNight : 'skipped'}\n`);
    for (const [tokenType, amount] of shieldedTokens) ctx.output.stdout(`SHIELDED_${tokenType}=${amount}\n`);
    ctx.output.stderr('\n' + divider() + '\n\n');
  } catch (err) {
    progress.fail('Failed');
    throw err;
  }
}
