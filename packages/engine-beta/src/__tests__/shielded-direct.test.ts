// The indexer-direct shielded reader on the beta engine, with the beta
// engine's own ledger. The tests are the suite both engines run:
// helpers/shielded-direct-suite.ts.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readShieldedBalanceDirect } from '../shielded-direct.ts';
import { deriveShieldedSeed } from '../derivation.ts';
import { resolvedPackageFolder } from '@kuiralabs/midnight-cli-core/engine';
import { shieldedDirectSuite } from '../../../../test-support/shielded-direct-suite.ts';

const ENGINE_DIR = new URL('../..', import.meta.url).pathname;
const ledger = await import(pathToFileURL(join(resolvedPackageFolder(ENGINE_DIR, '@midnightntwrk/ledger-v9')!, 'midnight_ledger_wasm_v9_fs.js')).href);

shieldedDirectSuite({
  set: 'beta',
  secretKeysFor: (seedHex: string): Parameters<typeof readShieldedBalanceDirect>[0] => ledger.ZswapSecretKeys.fromSeed(deriveShieldedSeed(Buffer.from(seedHex, 'hex'))),
  readShieldedBalanceDirect,
});
