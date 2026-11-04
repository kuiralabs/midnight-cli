// The packages this mn has, with their commands, agent guidance and error codes, collected
// into one registry. The shell assembles it: a definition and a package's
// guidance sit beside its commands, and the base can't import a package's
// commands. Reading it loads no handler, so no SDK. The shell's dispatch and
// flag checks read it, and so do help, the manual and the intro, the MCP
// server's tools, the agent manual and skills, and the shell's and the MCP
// server's classification of an error by its code.

import { getValidNetworkNames, createPackageRegistry, type FlagDefinition, type GlobalFlagHelp } from '@kuiralabs/midnight-cli-core';
import { configDefinition, coreGuidance, coreCodes } from '@kuiralabs/midnight-cli-core/commands';
import { walletDefinition, generateDefinition, infoDefinition, balanceDefinition, addressDefinition, genesisAddressDefinition, airdropDefinition, transferDefinition, dustDefinition, cacheDefinition, swapDefinition, walletGuidance, swapGuidance, walletCodes } from '@kuiralabs/midnight-wallet/commands';
import { inspectCostDefinition } from '../commands/inspect-cost.definition.ts';
import { serveDefinition } from '../commands/serve.definition.ts';
import { testDefinition } from '../commands/test.definition.ts';
import { devDefinition } from '../commands/dev.definition.ts';
import { contractDefinition } from '../commands/contract.definition.ts';
import { grantDefinition } from '../commands/grant.definition.ts';
import { localnetDefinition } from '../commands/localnet.definition.ts';
import { statusDefinition, txDefinition, chainGuidance, chainCodes } from '@kuiralabs/midnight-chain/commands';
import { helpDefinition } from '../commands/help.definition.ts';
import { manualDefinition } from '../commands/manual.definition.ts';
import { contractGuidance } from '../commands/contract.guidance.ts';
import { connectGuidance } from '../commands/connect.guidance.ts';
import { devGuidance } from '../commands/dev.guidance.ts';
import { grantGuidance } from '../commands/grant.guidance.ts';
import { contractCodes } from '../commands/contract.codes.ts';
import { devCodes } from '../commands/dev.codes.ts';
import { grantCodes } from '../commands/grant.codes.ts';

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
  { name: '--network <name>', description: `Override network (${getValidNetworkNames().join(', ')})` },
  { name: '--version, -v', description: 'Print CLI version' },
  { name: '--help, -h', description: 'Show help' },
];

/** Every package, in the layering's order; the shell's own commands last, its guidance being the skeletons. */
export const installedCommands = createPackageRegistry([
  { name: 'core', commands: [configDefinition], guidance: coreGuidance, codes: coreCodes },
  { name: 'chain', commands: [statusDefinition, txDefinition], guidance: chainGuidance, codes: chainCodes },
  {
    name: 'wallet',
    commands: [walletDefinition, generateDefinition, infoDefinition, balanceDefinition, addressDefinition, genesisAddressDefinition, airdropDefinition, transferDefinition, dustDefinition, cacheDefinition],
    guidance: walletGuidance,
    codes: walletCodes,
  },
  { name: 'contract', commands: [inspectCostDefinition, contractDefinition], guidance: contractGuidance, codes: contractCodes },
  { name: 'connect', commands: [serveDefinition], guidance: connectGuidance },
  { name: 'swap', commands: [swapDefinition], guidance: swapGuidance },
  { name: 'dev', commands: [testDefinition, devDefinition, localnetDefinition], guidance: devGuidance, codes: devCodes },
  { name: 'grant', commands: [grantDefinition], guidance: grantGuidance, codes: grantCodes },
  { name: 'shell', commands: [helpDefinition, manualDefinition], guidance: { pieces: [] } },
], GLOBAL_FLAGS, GLOBAL_FLAGS_HELP);
