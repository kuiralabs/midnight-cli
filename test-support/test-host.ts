// The host a test's calls run with: settings from the environment and the
// state root under the home directory, each read when used (tests change HOME
// and the environment as they go), notices dropped, nobody to ask, SDK
// warnings of its own (no host's filters report to it), and an engine of its
// own from the engines the CLI ships.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHost, type Host, type HostOptions, settingsFromEnvironment, MIDNIGHT_DIR } from '@kuiralabs/midnight-cli-core';
import { loadInstalledEngine } from '../src/lib/installed-engines.ts';

export function testHost(overrides: HostOptions = {}): Host {
  return createHost({
    settings: () => settingsFromEnvironment(process.env),
    paths: () => ({ stateRoot: join(homedir(), MIDNIGHT_DIR), home: homedir() }),
    engineLoader: loadInstalledEngine,
    ...overrides,
  });
}
