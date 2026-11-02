// The test run stands in for the shell: libraries read the environment the
// tests set (MN_PASSPHRASE, MN_SEED, …) as settings, keep their state under
// the home the tests set (HOME), and load the engines the CLI ships, as the
// CLI gives them.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { setSettingsSource, settingsFromEnvironment } from '@kuiralabs/midnight-cli-core/lib/settings';
import { setHostPathsSource } from '@kuiralabs/midnight-cli-core/lib/state-root';
import { MIDNIGHT_DIR } from '@kuiralabs/midnight-cli-core/lib/constants';
import { setEngineLoader } from '@kuiralabs/midnight-cli-core/lib/engine';
import { loadInstalledEngine } from '../../lib/installed-engines.ts';

setSettingsSource(() => settingsFromEnvironment(process.env));
setHostPathsSource(() => ({ stateRoot: join(homedir(), MIDNIGHT_DIR), home: homedir() }));
// And the engines this build ships, as the CLI gives them.
setEngineLoader(loadInstalledEngine);
