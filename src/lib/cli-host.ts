// A shell concern: what the CLI and the MCP server, as hosts, give the
// libraries at start (spec §3.1, §5.4, §7). Libraries never set these
// themselves; a consumer sets its own.
//   - the filters for the SDK's noise, acting while a call listens, and the
//     calls it runs, whose SDK warnings go to the call that raised them;
//   - a notice sink: stderr;
//   - settings, read from the environment as each is needed;
//   - the state root, ~/.midnight, read as each path is built.
// The prompter is the CLI's alone: the MCP server has no terminal to ask at.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { installSdkNoiseFilters } from './sdk-noise.ts';
import { setNoticeSink } from './notices.ts';
import { setSettingsSource, settingsFromEnvironment } from './settings.ts';
import { setHostPathsSource } from './state-root.ts';
import { MIDNIGHT_DIR } from './constants.ts';
import type { SdkWarningCalls } from './sdk-warnings.ts';

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
  return { sdkWarnings };
}
