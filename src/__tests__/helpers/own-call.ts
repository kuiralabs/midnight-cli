// A command run with SDK warnings of its own, for tests that run one command
// outside any host: no host's filters report to it.

import type { CommandRun } from '../../lib/run-command.ts';
import { testHost } from '../../../test-support/test-host.ts';

export function ownCall(run: Omit<CommandRun, 'host'> & { host?: CommandRun['host'] } = {}): CommandRun {
  return { ...run, host: run.host ?? testHost() };
}
