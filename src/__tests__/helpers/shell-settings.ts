// The test run stands in for the shell: libraries read the environment the
// tests set (MN_PASSPHRASE, MN_SEED, …) as settings, and load the engines the
// CLI ships, as the CLI gives them. Where state is kept, each test says: its
// host's paths (test-host.ts), or the root it passes a library.

import { setSettingsSource, settingsFromEnvironment } from '@kuiralabs/midnight-cli-core/lib/settings';
import { setEngineLoader } from '@kuiralabs/midnight-cli-core/lib/engine';
import { loadInstalledEngine } from '../../lib/installed-engines.ts';

setSettingsSource(() => settingsFromEnvironment(process.env));
// And the engines this build ships, as the CLI gives them.
setEngineLoader(loadInstalledEngine);
