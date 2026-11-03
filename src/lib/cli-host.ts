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
import { setPrompter, type Prompter } from '@kuiralabs/midnight-cli-core/lib/prompter';
import { MIDNIGHT_DIR } from '@kuiralabs/midnight-cli-core/lib/constants';
import { setEngineLoader } from '@kuiralabs/midnight-cli-core/lib/engine';
import { createHost, type Host } from '@kuiralabs/midnight-cli-core/lib/host';
import { loadInstalledEngine } from './installed-engines.ts';

/**
 * The CLI's host, or the MCP server's (`prompter` null: no terminal there).
 * Until every library takes the host it is given, the module-level sources
 * they still read are set from it.
 */
export function createCliHost({ prompter }: { prompter: Prompter | null }): Host {
  const host = createHost({
    settings: () => settingsFromEnvironment(process.env),
    paths: () => ({ stateRoot: join(homedir(), MIDNIGHT_DIR), home: homedir() }),
    notice: (line) => process.stderr.write(line + '\n'),
    prompter,
    sdkWarnings: installSdkNoiseFilters(),
  });
  setNoticeSink(host.notice);
  setSettingsSource(host.settings);
  setHostPathsSource(host.paths);
  setPrompter(host.prompter);
  setEngineLoader(loadInstalledEngine);
  return host;
}
