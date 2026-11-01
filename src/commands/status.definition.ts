// The `status` command, described once.

import type { CommandDefinition } from '../lib/command-definition.ts';

export const statusDefinition: CommandDefinition = {
  name: 'status',
  order: 190,
  // status is being reworked: the shell dispatches it only to refuse it, help
  // and the intro don't list it, and the MCP server can load it with no tool
  // to call it.
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
