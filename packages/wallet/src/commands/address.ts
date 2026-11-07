// address command — derive and display an unshielded address from a seed
// Bare address to stdout (pipeable), formatted details to stderr

import { type ParsedArgs, getFlag, hasFlag, resolveNetworkName, type CallContext, UsageError } from '@kuiralabs/midnight-cli-core';
import { keyValue, divider, formatAddress, dim } from '@kuiralabs/midnight-cli-core/ui';
import { resolveSeed } from '../lib/seed-resolver.ts';

/** The highest unhardened HD key index. */
const MAX_KEY_INDEX = 2 ** 31 - 1;

export default async function addressCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  // `address` is a seed-derivation tool with no active-wallet notion → requireExplicit.
  const root = ctx.config.paths.stateRoot;
  const seedBuffer = await resolveSeed(args, root, ctx.host, { requireExplicit: true, label: 'address' });

  const indexStr = getFlag(args, 'index');
  // An HD key index is below 2^31: the indexes above are hardened ones, which the SDK refuses.
  const keyIndex = indexStr === undefined ? 0 : /^\d+$/.test(indexStr) ? Number(indexStr) : Number.NaN;
  if (!Number.isSafeInteger(keyIndex) || keyIndex > MAX_KEY_INDEX) {
    throw new UsageError(`Key index must be a non-negative integer, at most ${MAX_KEY_INDEX}`);
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
