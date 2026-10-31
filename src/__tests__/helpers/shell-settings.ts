// The test run stands in for the shell: libraries read the environment the
// tests set (MN_PASSPHRASE, MN_SEED, …) as settings, as the CLI gives them.

import { setSettingsSource, settingsFromEnvironment } from '../../lib/settings.ts';

setSettingsSource(() => settingsFromEnvironment(process.env));
