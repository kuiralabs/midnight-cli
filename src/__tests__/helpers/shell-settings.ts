// The test run stands in for the shell: libraries read the environment the
// tests set (MN_PASSPHRASE, MN_SEED, …) as settings, and the libraries that
// don't take their host's engines yet reach the engines of a host made with
// the engines the CLI ships, as the CLI bridges them. Where state is kept, each
// test says: its host's paths (test-host.ts), or the root it passes a library.

import { setSettingsSource, settingsFromEnvironment } from '@kuiralabs/midnight-cli-core/lib/settings';
import { bridgeEngines } from '@kuiralabs/midnight-cli-core/lib/engine';
import { testHost } from './test-host.ts';

setSettingsSource(() => settingsFromEnvironment(process.env));
bridgeEngines(testHost().engines);
