// genesis-address command — display the genesis wallet address (seed 0x01)

import { type ParsedArgs, hasFlag, GENESIS_SEED, resolveNetworkName, type CallContext } from '@kuiralabs/midnight-cli-core';
import { keyValue, divider, formatAddress, dim } from '@kuiralabs/midnight-cli-core/ui';

export default async function genesisAddressCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const root = ctx.config.paths.stateRoot;
  const networkName = resolveNetworkName({ args, configDir: root });
  const seedBuffer = Buffer.from(GENESIS_SEED, 'hex');
  const address = (await ctx.host.engines.for(networkName)).keys.unshieldedAddress(seedBuffer, networkName);

  // JSON mode
  if (hasFlag(args, 'json')) {
    ctx.output.result({ address, network: networkName });
    return;
  }

  // Bare address to stdout (pipeable)
  ctx.output.stdout(address + '\n');

  // Details to stderr
  ctx.output.stderr('\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n');
  ctx.output.stderr(keyValue('Address', formatAddress(address)) + '\n');
  ctx.output.stderr(keyValue('Seed', dim('0x01 (genesis)')) + '\n');
  ctx.output.stderr(divider() + '\n\n');
}
