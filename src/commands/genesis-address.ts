// genesis-address command — display the genesis wallet address (seed 0x01)

import { type ParsedArgs, hasFlag } from '../lib/argv.ts';
import { GENESIS_SEED } from '../lib/constants.ts';
import { engineFor } from '../lib/engine.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import { keyValue, divider, formatAddress } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';
import type { CallContext } from '../lib/call-context.ts';

export default async function genesisAddressCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const networkName = resolveNetworkName({ args });
  const seedBuffer = Buffer.from(GENESIS_SEED, 'hex');
  const address = (await engineFor(networkName)).keys.unshieldedAddress(seedBuffer, networkName);

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
