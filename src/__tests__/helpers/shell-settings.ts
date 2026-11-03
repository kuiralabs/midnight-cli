// The test run stands in for the shell: libraries read the environment the
// tests set (MN_PASSPHRASE, MN_SEED, …) as settings. Where state is kept and
// which engine runs, each test says: its host's paths and engines
// (test-host.ts), or the root and engines it passes a library.

import { setSettingsSource, settingsFromEnvironment } from '@kuiralabs/midnight-cli-core/lib/settings';

setSettingsSource(() => settingsFromEnvironment(process.env));
