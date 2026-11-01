// The commands this mn has, collected into one registry (plan 2B). The shell
// assembles it: a definition sits beside its command in each package, and the
// base can't import a package's commands. Reading it loads no handler, so no SDK.
// Nothing uses it yet but the tests that rebuild today's lists from it; 2C–2E
// switch dispatch, help and the MCP tools over to it.

import { createCommandRegistry, type FlagDefinition } from './command-definition.ts';
import { walletDefinition } from '../commands/wallet.definition.ts';
import { generateDefinition } from '../commands/generate.definition.ts';
import { infoDefinition } from '../commands/info.definition.ts';
import { balanceDefinition } from '../commands/balance.definition.ts';
import { addressDefinition } from '../commands/address.definition.ts';
import { genesisAddressDefinition } from '../commands/genesis-address.definition.ts';
import { inspectCostDefinition } from '../commands/inspect-cost.definition.ts';
import { airdropDefinition } from '../commands/airdrop.definition.ts';
import { transferDefinition } from '../commands/transfer.definition.ts';
import { dustDefinition } from '../commands/dust.definition.ts';
import { configDefinition } from '../commands/config.definition.ts';
import { cacheDefinition } from '../commands/cache.definition.ts';
import { serveDefinition } from '../commands/serve.definition.ts';
import { testDefinition } from '../commands/test.definition.ts';
import { devDefinition } from '../commands/dev.definition.ts';
import { contractDefinition } from '../commands/contract.definition.ts';
import { grantDefinition } from '../commands/grant.definition.ts';
import { localnetDefinition } from '../commands/localnet.definition.ts';
import { statusDefinition } from '../commands/status.definition.ts';
import { helpDefinition } from '../commands/help.definition.ts';
import { manualDefinition } from '../commands/manual.definition.ts';

/** Accepted on every command. */
const GLOBAL_FLAGS: readonly FlagDefinition[] = [
  { name: 'help', takesValue: false },
  { name: 'h', takesValue: false },
  { name: 'json', takesValue: false },
  { name: 'version', takesValue: false },
  { name: 'v', takesValue: false },
];

/** Every command, in help's order (status, which help doesn't list, where its old help entry sat). */
export const installedCommands = createCommandRegistry([
  walletDefinition,
  generateDefinition,
  infoDefinition,
  balanceDefinition,
  addressDefinition,
  genesisAddressDefinition,
  inspectCostDefinition,
  airdropDefinition,
  transferDefinition,
  dustDefinition,
  configDefinition,
  cacheDefinition,
  serveDefinition,
  testDefinition,
  devDefinition,
  contractDefinition,
  grantDefinition,
  localnetDefinition,
  statusDefinition,
  helpDefinition,
  manualDefinition,
], GLOBAL_FLAGS);
