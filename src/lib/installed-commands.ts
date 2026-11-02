// The packages this mn has, with their commands and agent guidance, collected
// into one registry. The shell assembles it: a definition and a package's
// guidance sit beside its commands, and the base can't import a package's
// commands. Reading it loads no handler, so no SDK. The shell's dispatch and
// flag checks read it, and so do help, the manual and the intro, the MCP
// server's tools, and the agent manual and skills.

import { createPackageRegistry, type FlagDefinition, type GlobalFlagHelp } from '@kuiralabs/midnight-cli-core/lib/command-definition';
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
import { configDefinition } from '@kuiralabs/midnight-cli-core/commands/config.definition';
import { cacheDefinition } from '../commands/cache.definition.ts';
import { serveDefinition } from '../commands/serve.definition.ts';
import { testDefinition } from '../commands/test.definition.ts';
import { devDefinition } from '../commands/dev.definition.ts';
import { contractDefinition } from '../commands/contract.definition.ts';
import { grantDefinition } from '../commands/grant.definition.ts';
import { localnetDefinition } from '../commands/localnet.definition.ts';
import { statusDefinition } from '@kuiralabs/midnight-chain/commands/status.definition';
import { helpDefinition } from '../commands/help.definition.ts';
import { manualDefinition } from '../commands/manual.definition.ts';
import { coreGuidance } from '@kuiralabs/midnight-cli-core/commands/core.guidance';
import { chainGuidance } from '@kuiralabs/midnight-chain/commands/chain.guidance';
import { walletGuidance } from '../commands/wallet.guidance.ts';
import { contractGuidance } from '../commands/contract.guidance.ts';
import { connectGuidance } from '../commands/connect.guidance.ts';
import { devGuidance } from '../commands/dev.guidance.ts';
import { grantGuidance } from '../commands/grant.guidance.ts';

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

/** Every package, in the layering's order; the shell's own commands last, its guidance being the skeletons. */
export const installedCommands = createPackageRegistry([
  { name: 'core', commands: [configDefinition], guidance: coreGuidance },
  { name: 'chain', commands: [statusDefinition], guidance: chainGuidance },
  {
    name: 'wallet',
    commands: [walletDefinition, generateDefinition, infoDefinition, balanceDefinition, addressDefinition, genesisAddressDefinition, airdropDefinition, transferDefinition, dustDefinition, cacheDefinition],
    guidance: walletGuidance,
  },
  { name: 'contract', commands: [inspectCostDefinition, contractDefinition], guidance: contractGuidance },
  { name: 'connect', commands: [serveDefinition], guidance: connectGuidance },
  { name: 'dev', commands: [testDefinition, devDefinition, localnetDefinition], guidance: devGuidance },
  { name: 'grant', commands: [grantDefinition], guidance: grantGuidance },
  { name: 'shell', commands: [helpDefinition, manualDefinition], guidance: { pieces: [] } },
], GLOBAL_FLAGS, GLOBAL_FLAGS_HELP);
