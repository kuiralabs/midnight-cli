// cache command — manage wallet state cache
// cache clear [--network <name>] [--wallet <name|file>]

import { type ParsedArgs, getFlag, hasFlag, UsageError, throwIfCancelled, clearWalletCache, clearDustDirectCache, clearNativeDustCheckpoint, clearShieldedDirectCache, resolveNetworkName, type CallContext } from '@kuiralabs/midnight-cli-core';
import { green } from '@kuiralabs/midnight-cli-core/ui';
import { resolveWalletPath, unlockWallet } from '../lib/wallet-config.ts';
import { clearChainCaches } from '../lib/chain-caches.ts';

export default async function cacheCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const action = args.subcommand;

  if (action !== 'clear') {
    throw new UsageError(
      `Usage: midnight cache clear [--network <name>] [--wallet <name|file>]`
    );
  }

  const root = ctx.config.paths.stateRoot;
  const walletFlag = getFlag(args, 'wallet');
  const networkFlag = getFlag(args, 'network');
  const jsonMode = hasFlag(args, 'json');

  if (walletFlag) {
    // Clear cache for a specific wallet
    const walletPath = resolveWalletPath(root, walletFlag);
    const config = await unlockWallet(walletPath, { root, host: ctx.host });
    // Cancelled while the wallet was unlocked: no cache is cleared.
    throwIfCancelled(ctx.signal);
    const networkName = resolveNetworkName({ args, configDir: root });
    const address = config.addresses[networkName];
    clearWalletCache(address, networkName, root);
    // Also clear the dust-direct cache for this wallet on this network.
    const { keys } = await ctx.host.engines.for(networkName);
    const dustPubkey = keys.dustPublicKeyHex(Buffer.from(config.seed, 'hex'));
    clearDustDirectCache(networkName, dustPubkey, root);
    clearNativeDustCheckpoint(networkName, dustPubkey, root);
    // And the shielded-direct cache (keyed by the wallet's coin public key).
    const shieldedPubkey = keys.shieldedCoinPublicKeyHex(Buffer.from(config.seed, 'hex'));
    clearShieldedDirectCache(networkName, shieldedPubkey, root);
    if (jsonMode) {
      ctx.output.result({ action: 'clear', scope: 'wallet', wallet: walletFlag, network: networkName });
      return;
    }
    ctx.output.stderr(green('✓') + ` Cache cleared for wallet "${walletFlag}" on ${networkName}\n`);
  } else if (networkFlag) {
    // Clear cache for a specific network
    clearChainCaches(networkFlag, root);
    if (jsonMode) {
      ctx.output.result({ action: 'clear', scope: 'network', network: networkFlag });
      return;
    }
    ctx.output.stderr(green('✓') + ` Cache cleared for network "${networkFlag}"\n`);
  } else {
    // Clear all cache
    clearChainCaches(undefined, root);
    if (jsonMode) {
      ctx.output.result({ action: 'clear', scope: 'all' });
      return;
    }
    ctx.output.stderr(green('✓') + ' Cache cleared\n');
  }
}
