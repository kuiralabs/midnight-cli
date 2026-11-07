// A shell concern: the host the CLI and the MCP server each build at start,
// which their calls pass to the libraries. A consumer builds its own.
//   - the guard against the SDK's transient rejections, with its console
//     filters, acting while a call listens (a rejection outside any call
//     exits 1), and the calls it runs, whose SDK warnings go to the call that
//     raised them;
//   - a notice sink: stderr;
//   - settings, read from the environment as each is needed;
//   - the state root, ~/.midnight, read as each path is built;
//   - the SDK engines this build ships, as its engine loader.
// The prompter is the CLI's alone: the MCP server has no terminal to ask at.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { installSdkProcessGuard } from '@kuiralabs/midnight-cli-core/process';
import { settingsFromEnvironment, type Prompter, MIDNIGHT_DIR, createHost, type Host } from '@kuiralabs/midnight-cli-core';
import { loadInstalledEngine } from './installed-engines.ts';

/**
 * The CLI's host, or the MCP server's (`prompter` null: no terminal there).
 * Made once per process: each installs a process guard of its own. With
 * `notices` false (a --json run of the CLI without --verbose) the libraries'
 * notices are dropped, so stderr stays quiet.
 */
export function createCliHost({ prompter, notices = true }: { prompter: Prompter | null; notices?: boolean }): Host {
  return createHost({
    settings: () => settingsFromEnvironment(process.env),
    paths: () => ({ stateRoot: join(homedir(), MIDNIGHT_DIR), home: homedir() }),
    notice: notices ? (line) => process.stderr.write(line + '\n') : () => {},
    prompter,
    sdkWarnings: installSdkProcessGuard({ console: true, outsideCalls: 'exit' }).calls,
    engineLoader: loadInstalledEngine,
  });
}
