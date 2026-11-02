// A shell concern: what the CLI and the MCP server, as hosts, give the
// libraries at start. Libraries never set these
// themselves; a consumer sets its own.
//   - the filters for the SDK's noise, acting while a call listens, and the
//     calls it runs, whose SDK warnings go to the call that raised them;
//   - a notice sink: stderr;
//   - settings, read from the environment as each is needed;
//   - the state root, ~/.midnight, read as each path is built;
//   - the SDK engines this build ships.
// The prompter is the CLI's alone: the MCP server has no terminal to ask at.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { installSdkNoiseFilters } from './sdk-noise.ts';
import { setNoticeSink } from '@kuiralabs/midnight-cli-core/lib/notices';
import { setSettingsSource, settingsFromEnvironment } from '@kuiralabs/midnight-cli-core/lib/settings';
import { setHostPathsSource } from '@kuiralabs/midnight-cli-core/lib/state-root';
import { MIDNIGHT_DIR } from '@kuiralabs/midnight-cli-core/lib/constants';
import { setEngineLoader } from '@kuiralabs/midnight-cli-core/lib/engine';
import { loadInstalledEngine } from './installed-engines.ts';
import type { SdkWarningCalls } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';

/** What the host gives its runners. */
export interface CliHost {
  /** Runs each call with its own SDK warnings. */
  readonly sdkWarnings: SdkWarningCalls;
}

export function installCliHost(): CliHost {
  const sdkWarnings = installSdkNoiseFilters();
  setNoticeSink((line) => process.stderr.write(line + '\n'));
  setSettingsSource(() => settingsFromEnvironment(process.env));
  setHostPathsSource(() => ({ stateRoot: join(homedir(), MIDNIGHT_DIR), home: homedir() }));
  setEngineLoader(loadInstalledEngine);
  return { sdkWarnings };
}
