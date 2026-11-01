// The `status` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

export const statusDefinition: CommandDefinition = {
  name: 'status',
  order: 190,
  // Y29: the shell dispatches status only to refuse it, help and the intro
  // don't list it, and the MCP server can load it with no tool to call it.
  // Recorded as each list has it, fixed in 2C–2G.
  flags: [
    { name: 'all', takesValue: false },
    { name: 'network', takesValue: true },
    { name: 'watch', takesValue: false },
  ],
  needsWalletSdk: false,
  shell: { unavailable: 'The "status" command is currently being reworked. Check back soon.' },
  load: () => import('./status.ts'),
  mcp: { tools: [] },
};
