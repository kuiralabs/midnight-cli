// A command run with SDK warnings of its own, for tests that run one command
// outside any host: no host's filters report to it.

import type { CommandRun } from '../../lib/run-command.ts';
import { createSdkWarningRouter, sdkWarningCallsOn } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';

export function ownCall(run: Omit<CommandRun, 'sdkWarnings'> = {}): CommandRun {
  return { ...run, sdkWarnings: sdkWarningCallsOn(createSdkWarningRouter()) };
}
