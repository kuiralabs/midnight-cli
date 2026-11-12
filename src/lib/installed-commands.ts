// The packages this mn has, with their commands, agent guidance and error codes, collected
// into one registry. The shell assembles it: a definition and a package's
// guidance sit beside its commands, and the base can't import a package's
// commands. Reading it loads no handler, so no SDK. The shell's dispatch and
// flag checks read it, and so do help, the manual and the intro, the MCP
// server's tools, the agent manual and skills, and the shell's and the MCP
// server's classification of an error by its code.

import { getValidNetworkNames, createPackageRegistry, type FlagDefinition, type GlobalFlagHelp } from '@kuiralabs/midnight-cli-core';
import { coreCommands } from '@kuiralabs/midnight-cli-core/commands';
import { walletCommands, swapCommands } from '@kuiralabs/midnight-wallet/commands';
import { contractCommands } from '@kuiralabs/midnight-contract/commands';
import { connectCommands } from '@kuiralabs/midnight-connect/commands';
import { devCommands } from '@kuiralabs/midnight-dev/commands';
import { grantCommands } from '@kuiralabs/midnight-grant/commands';
import { chainCommands } from '@kuiralabs/midnight-chain/commands';
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
  { name: '--json', description: 'Output structured JSON to stdout (stderr stays quiet but for the lines of a long step: a wait for Dust, a sync or read of the chain\'s events, a proof)' },
  { name: '--wallet <name|file>', description: 'Wallet name or path' },
  { name: '--network <name>', description: `Override network (${getValidNetworkNames().join(', ')})` },
  { name: '--version, -v', description: 'Print CLI version' },
  { name: '--help, -h', description: 'Show help' },
];

/** Every package, in the layering's order; the shell's own commands last, its guidance being the skeletons. */
export const installedCommands = createPackageRegistry([
  coreCommands,
  chainCommands,
  walletCommands,
  contractCommands,
  connectCommands,
  swapCommands,
  devCommands,
  grantCommands,
  { name: 'shell', commands: [helpDefinition, manualDefinition], guidance: { pieces: [] } },
], GLOBAL_FLAGS, GLOBAL_FLAGS_HELP);
