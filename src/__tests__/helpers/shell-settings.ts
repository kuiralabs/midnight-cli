// The test run stands in for the shell: libraries read the environment the
// tests set (MN_PASSPHRASE, MN_SEED, …) as settings, and keep their state
// under the home the tests set (HOME), as the CLI gives them.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { setSettingsSource, settingsFromEnvironment } from '../../lib/settings.ts';
import { setHostPathsSource } from '../../lib/state-root.ts';
import { MIDNIGHT_DIR } from '../../lib/constants.ts';

setSettingsSource(() => settingsFromEnvironment(process.env));
setHostPathsSource(() => ({ stateRoot: join(homedir(), MIDNIGHT_DIR), home: homedir() }));
