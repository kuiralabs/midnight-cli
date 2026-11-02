// The indexer-direct shielded reader on the beta engine, with the beta
// engine's own ledger. The tests are the suite both engines run:
// helpers/shielded-direct-suite.ts.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readShieldedBalanceDirect } from '@kuiralabs/midnight-engine-beta/shielded-direct';
import { deriveShieldedSeed } from '@kuiralabs/midnight-engine-beta/derivation';
import { resolvedPackageFolder } from '@kuiralabs/midnight-cli-core/lib/sdk-layout';
import { shieldedDirectSuite } from './helpers/shielded-direct-suite.ts';

const ENGINE_DIR = new URL('../../packages/engine-beta', import.meta.url).pathname;
const ledger = await import(pathToFileURL(join(resolvedPackageFolder(ENGINE_DIR, '@midnightntwrk/ledger-v9')!, 'midnight_ledger_wasm_v9_fs.js')).href);

shieldedDirectSuite({
  set: 'beta',
  secretKeysFor: (seedHex: string): Parameters<typeof readShieldedBalanceDirect>[0] => ledger.ZswapSecretKeys.fromSeed(deriveShieldedSeed(Buffer.from(seedHex, 'hex'))),
  readShieldedBalanceDirect,
});
