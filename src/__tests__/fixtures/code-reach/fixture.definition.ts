// A command for the code reach check: its handler imports a module that throws
// NotAnOfferError (NOT_AN_OFFER), and it declares no code.

import type { CommandDefinition } from '@kuiralabs/midnight-cli-core';

export const fixtureDefinition: CommandDefinition = {
  name: 'code-reach-fixture',
  order: 9_999,
  flags: [],
  needsWalletSdk: false,
  shell: {},
  errors: { codes: [] },
  load: () => import('./handler.ts'),
};
