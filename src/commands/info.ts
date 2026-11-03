// info command — display wallet metadata (no secrets)
// Shows addresses for all networks + shielded, creation date, file path

import { type ParsedArgs, getFlag, hasFlag } from '@kuiralabs/midnight-cli-core/lib/argv';
import { loadWalletConfig, resolveWalletPath, walletAddress } from '../lib/wallet-config.ts';
import { resolveNetworkName } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { header, divider } from '@kuiralabs/midnight-cli-core/ui/format';
import { formatAddress } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, dim, teal } from '@kuiralabs/midnight-cli-core/ui/colors';
import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';

export default async function infoCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const root = ctx.config.paths.stateRoot;
  const resolvedPath = resolveWalletPath(root, getFlag(args, 'wallet'));
  const config = await loadWalletConfig(resolvedPath);
  const activeNetwork = resolveNetworkName({ args, configDir: root });
  const activeAddress = await walletAddress(resolvedPath, activeNetwork, root);

  // JSON mode
  if (hasFlag(args, 'json')) {
    const result: Record<string, unknown> = {
      addresses: config.addresses,
      activeNetwork,
      activeAddress,
      createdAt: config.createdAt,
      file: resolvedPath,
    };
    if (config.shieldedAddresses) result.shieldedAddresses = config.shieldedAddresses;
    ctx.output.result(result);
    return;
  }

  // Bare active address to stdout (pipeable)
  ctx.output.stdout(activeAddress + '\n');

  // Header
  ctx.output.stderr('\n' + header('Wallet Info') + '\n\n');

  // Per-network grouping — unshielded + shielded together
  const networks = Object.keys(config.addresses) as Array<keyof typeof config.addresses>;
  for (let i = 0; i < networks.length; i++) {
    const network = networks[i] as string;
    const isActiveNet = network === activeNetwork;
    const unshielded = config.addresses[network as keyof typeof config.addresses];
    const shielded = config.shieldedAddresses?.[network as keyof typeof config.addresses];

    const label = isActiveNet ? bold(teal(network)) + dim('  (active)') : network;
    ctx.output.stderr(`  ${label}\n`);
    ctx.output.stderr(`    ${dim('unshielded')}  ${formatAddress(unshielded as string)}\n`);
    if (shielded) {
      ctx.output.stderr(`    ${dim('shielded  ')}  ${formatAddress(shielded)}\n`);
    } else {
      ctx.output.stderr(`    ${dim('shielded  ')}  ${dim('(unavailable)')}\n`);
    }
    if (i < networks.length - 1) ctx.output.stderr('\n');
  }

  // Footer
  ctx.output.stderr('\n' + divider() + '\n\n');
  ctx.output.stderr(`  ${dim('created')}  ${config.createdAt}\n`);
  ctx.output.stderr(`  ${dim('file   ')}  ${resolvedPath}\n\n`);
}
