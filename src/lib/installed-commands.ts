// The commands this mn has, collected into one registry (plan 2B). The shell
// assembles it: a definition sits beside its command in each package, and the
// base can't import a package's commands. Reading it loads no handler, so no SDK.
// The shell's dispatch and flag checks read it (2C), and so do help, the manual
// and the intro (2D), and the MCP server's tools (2E).

import { createCommandRegistry, type FlagDefinition, type GlobalFlagHelp } from './command-definition.ts';
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

/** The shell answers these before any command runs: no tool passes them on. */
const SHELL_ANSWERS = { notForAgents: 'the shell answers it before any command runs' };

/** Accepted on every command. */
const GLOBAL_FLAGS: readonly FlagDefinition[] = [
  { name: 'help', takesValue: false, agent: SHELL_ANSWERS },
  { name: 'h', takesValue: false, agent: SHELL_ANSWERS },
  { name: 'json', takesValue: false, agent: { notForAgents: 'the MCP server always sets it' } },
  { name: 'version', takesValue: false, agent: SHELL_ANSWERS },
  { name: 'v', takesValue: false, agent: SHELL_ANSWERS },
];

/**
 * The global flags `help --json` lists. Besides the flags every command
 * accepts, it names --wallet and --network, which most commands take.
 */
const GLOBAL_FLAGS_HELP: readonly GlobalFlagHelp[] = [
  { name: '--json', description: 'Output structured JSON to stdout (suppresses all stderr)' },
  { name: '--wallet <name|file>', description: 'Wallet name or path' },
  { name: '--network <name>', description: 'Override network (preprod, preview, undeployed)' },
  { name: '--version, -v', description: 'Print CLI version' },
  { name: '--help, -h', description: 'Show help' },
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
], GLOBAL_FLAGS, GLOBAL_FLAGS_HELP);
