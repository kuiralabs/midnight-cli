// The indexer-direct shielded reader on the rc engine. The tests are the
// suite both engines run: helpers/shielded-direct-suite.ts.

import * as ledger from '@midnightntwrk/ledger-v9';
import { readShieldedBalanceDirect } from '../shielded-direct.ts';
import { deriveShieldedSeed } from '../derivation.ts';
import { shieldedDirectSuite } from '../../../../test-support/shielded-direct-suite.ts';

shieldedDirectSuite({
  set: 'rc',
  secretKeysFor: (seedHex: string): Parameters<typeof readShieldedBalanceDirect>[0] => ledger.ZswapSecretKeys.fromSeed(deriveShieldedSeed(Buffer.from(seedHex, 'hex'))),
  readShieldedBalanceDirect,
});
