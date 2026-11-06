// A command for the code reach check whose handler imports one name from a
// barrel: it reaches that name's module and no other the barrel lists.

import type { CommandDefinition } from '@kuiralabs/midnight-cli-core';

export const barrelFixtureDefinition: CommandDefinition = {
  name: 'code-reach-barrel-fixture',
  order: 9_999,
  flags: [],
  needsWalletSdk: false,
  shell: {},
  errors: { codes: [] },
  load: () => import('./barrel-handler.ts'),
};
