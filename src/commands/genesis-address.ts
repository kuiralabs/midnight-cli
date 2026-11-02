// genesis-address command — display the genesis wallet address (seed 0x01)

import { type ParsedArgs, hasFlag } from '@kuiralabs/midnight-cli-core/lib/argv';
import { GENESIS_SEED } from '@kuiralabs/midnight-cli-core/lib/constants';
import { engineFor } from '@kuiralabs/midnight-cli-core/lib/engine';
import { resolveNetworkName } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { keyValue, divider, formatAddress } from '@kuiralabs/midnight-cli-core/ui/format';
import { dim } from '@kuiralabs/midnight-cli-core/ui/colors';
import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';

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
