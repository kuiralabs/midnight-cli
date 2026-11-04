// address command — derive and display an unshielded address from a seed
// Bare address to stdout (pipeable), formatted details to stderr

import { type ParsedArgs, getFlag, hasFlag, resolveNetworkName, type CallContext, UsageError } from '@kuiralabs/midnight-cli-core';
import { keyValue, divider, formatAddress, dim } from '@kuiralabs/midnight-cli-core/ui';
import { resolveSeed } from '../lib/seed-resolver.ts';

export default async function addressCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  // `address` is a seed-derivation tool with no active-wallet notion → requireExplicit.
  const root = ctx.config.paths.stateRoot;
  const seedBuffer = await resolveSeed(args, root, ctx.host, { requireExplicit: true, label: 'address' });

  const indexStr = getFlag(args, 'index');
  const keyIndex = indexStr !== undefined ? parseInt(indexStr, 10) : 0;
  if (isNaN(keyIndex) || keyIndex < 0 || !Number.isInteger(Number(indexStr ?? '0'))) {
    throw new UsageError('Key index must be a non-negative integer');
  }

  const networkName = resolveNetworkName({ args, configDir: root });
  const address = (await ctx.host.engines.for(networkName)).keys.unshieldedAddress(seedBuffer, networkName, keyIndex);
  const derivationPath = `m/44'/2400'/0'/NightExternal/${keyIndex}`;

  // JSON mode
  if (hasFlag(args, 'json')) {
    ctx.output.result({
      address,
      network: networkName,
      index: keyIndex,
      path: derivationPath,
    });
    return;
  }

  // Bare address to stdout (pipeable)
  ctx.output.stdout(address + '\n');

  // Formatted details to stderr
  ctx.output.stderr('\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n');
  ctx.output.stderr(keyValue('Index', keyIndex.toString()) + '\n');
  ctx.output.stderr(keyValue('Address', formatAddress(address)) + '\n');
  ctx.output.stderr(keyValue('Path', dim(derivationPath)) + '\n');
  ctx.output.stderr(divider() + '\n\n');
}
