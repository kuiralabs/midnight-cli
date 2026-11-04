// A shell concern: the host the CLI and the MCP server each build at start,
// which their calls pass to the libraries. A consumer builds its own.
//   - the filters for the SDK's noise, acting while a call listens, and the
//     calls it runs, whose SDK warnings go to the call that raised them;
//   - a notice sink: stderr;
//   - settings, read from the environment as each is needed;
//   - the state root, ~/.midnight, read as each path is built;
//   - the SDK engines this build ships, as its engine loader.
// The prompter is the CLI's alone: the MCP server has no terminal to ask at.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { installSdkNoiseFilters } from './sdk-noise.ts';
import { settingsFromEnvironment, type Prompter, MIDNIGHT_DIR, createHost, type Host } from '@kuiralabs/midnight-cli-core';
import { loadInstalledEngine } from './installed-engines.ts';

/** The CLI's host, or the MCP server's (`prompter` null: no terminal there). */
export function createCliHost({ prompter }: { prompter: Prompter | null }): Host {
  return createHost({
    settings: () => settingsFromEnvironment(process.env),
    paths: () => ({ stateRoot: join(homedir(), MIDNIGHT_DIR), home: homedir() }),
    notice: (line) => process.stderr.write(line + '\n'),
    prompter,
    sdkWarnings: installSdkNoiseFilters(),
    engineLoader: loadInstalledEngine,
  });
}
