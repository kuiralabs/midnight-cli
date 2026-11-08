// The indexer-direct shielded reader on the rc engine. The tests are the
// shared suite: test-support/shielded-direct-suite.ts.

import { readShieldedBalanceDirect } from '../shielded-direct.ts';
import { deriveShieldedSeed } from '../derivation.ts';
import { shieldedKeysFromSeed } from '../shielded-ledger-state.ts';
import { shieldedDirectSuite } from '../../../../test-support/shielded-direct-suite.ts';

shieldedDirectSuite({
  set: 'rc',
  secretKeysFor: (seedHex: string): Parameters<typeof readShieldedBalanceDirect>[0] => shieldedKeysFromSeed(deriveShieldedSeed(Buffer.from(seedHex, 'hex'))),
  readShieldedBalanceDirect,
});
