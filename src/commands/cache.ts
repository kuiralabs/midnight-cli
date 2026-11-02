// cache command — manage wallet state cache
// cache clear [--network <name>] [--wallet <name|file>]

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { UsageError, throwIfCancelled } from '../lib/errors.ts';
import { clearWalletCache } from '../lib/wallet-cache.ts';
import { clearDustDirectCache, clearNativeDustCheckpoint, clearShieldedDirectCache } from '../lib/reader-cache-files.ts';
import { engineFor } from '../lib/engine.ts';
import { resolveWalletPath, unlockWallet } from '../lib/wallet-config.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import { green } from '../ui/colors.ts';
import type { CallContext } from '../lib/call-context.ts';
import { clearChainCaches } from '../lib/chain-caches.ts';

export default async function cacheCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const action = args.subcommand;

  if (action !== 'clear') {
    throw new UsageError(
      `Usage: midnight cache clear [--network <name>] [--wallet <name|file>]`
    );
  }

  const walletFlag = getFlag(args, 'wallet');
  const networkFlag = getFlag(args, 'network');
  const jsonMode = hasFlag(args, 'json');

  if (walletFlag) {
    // Clear cache for a specific wallet
    const walletPath = resolveWalletPath(walletFlag);
    const config = await unlockWallet(walletPath);
    // Cancelled while the wallet was unlocked: no cache is cleared.
    throwIfCancelled(ctx.signal);
    const networkName = resolveNetworkName({ args });
    const address = config.addresses[networkName];
    clearWalletCache(address, networkName);
    // Also clear the dust-direct cache for this wallet on this network.
    const { keys } = await engineFor(networkName);
    const dustPubkey = keys.dustPublicKeyHex(Buffer.from(config.seed, 'hex'));
    clearDustDirectCache(networkName, dustPubkey);
    clearNativeDustCheckpoint(networkName, dustPubkey);
    // And the shielded-direct cache (keyed by the wallet's coin public key).
    const shieldedPubkey = keys.shieldedCoinPublicKeyHex(Buffer.from(config.seed, 'hex'));
    clearShieldedDirectCache(networkName, shieldedPubkey);
    if (jsonMode) {
      ctx.output.result({ action: 'clear', scope: 'wallet', wallet: walletFlag, network: networkName });
      return;
    }
    ctx.output.stderr(green('✓') + ` Cache cleared for wallet "${walletFlag}" on ${networkName}\n`);
  } else if (networkFlag) {
    // Clear cache for a specific network
    clearChainCaches(networkFlag);
    if (jsonMode) {
      ctx.output.result({ action: 'clear', scope: 'network', network: networkFlag });
      return;
    }
    ctx.output.stderr(green('✓') + ` Cache cleared for network "${networkFlag}"\n`);
  } else {
    // Clear all cache
    clearChainCaches(undefined);
    if (jsonMode) {
      ctx.output.result({ action: 'clear', scope: 'all' });
      return;
    }
    ctx.output.stderr(green('✓') + ' Cache cleared\n');
  }
}
