// A command run with SDK warnings of its own, for tests that run one command
// outside any host: no host's filters report to it. Its text for the person
// goes to the process's stderr, as the MCP server's does.

import type { CommandRun } from '@kuiralabs/midnight-cli-core';
import { testHost } from '../../../test-support/test-host.ts';

export type OwnCall = CommandRun & { readonly text: (text: string) => void };

export function ownCall(run: Omit<CommandRun, 'host'> & { host?: CommandRun['host'] } = {}): OwnCall {
  return { ...run, host: run.host ?? testHost(), text: (text) => { process.stderr.write(text); } };
}
