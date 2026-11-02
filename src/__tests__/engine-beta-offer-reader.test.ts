// The offer reader on the beta engine, with the beta engine's own ledger. The
// tests are the suite both engines run: helpers/offer-reader-suite.ts.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readOffer, spentNullifiers } from '@kuiralabs/midnight-engine-beta/offer-reader';
import { resolvedPackageFolder } from '@kuiralabs/midnight-cli-core/lib/sdk-layout';
import { offerReaderSuite } from './helpers/offer-reader-suite.ts';

const ENGINE_DIR = new URL('../../packages/engine-beta', import.meta.url).pathname;
const ledger = await import(pathToFileURL(join(resolvedPackageFolder(ENGINE_DIR, '@midnightntwrk/ledger-v9')!, 'midnight_ledger_wasm_v9_fs.js')).href);

offerReaderSuite({ set: 'beta', ledger, readOffer, spentNullifiers });
