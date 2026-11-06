// The DApp connector's tests over the beta engine (stagenet). The tests are
// the suite both engines run: helpers/connector-suite.ts. The SDK pieces come
// from the beta engine's own copies, as its connector resolves them; the
// repository's root holds the rc set's.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDAppConnector, signatureScheme, toHistoryEntry } from '../dapp-connector.ts';
import { PartlySignedTransactionError } from '../sign-recipe.ts';
import { deriveAllShieldedAddresses, deriveShieldedAddress, deriveUnshieldedAddress } from '../derive-address.ts';
import { resolvedPackageFolder } from '@kuiralabs/midnight-cli-core/engine';
import { connectorSuite } from '../../../../test-support/connector-suite.ts';

const ENGINE_DIR = new URL('../..', import.meta.url).pathname;
/** A module of a package as the beta engine resolves it. */
const fromEngine = async (name: string, entry: string) => import(pathToFileURL(join(resolvedPackageFolder(ENGINE_DIR, name)!, entry)).href);

const ledger = await fromEngine('@midnightntwrk/ledger-v9', 'midnight_ledger_wasm_v9_fs.js');
const { DustAddress, MidnightBech32m, UnshieldedAddress } = await fromEngine('@midnightntwrk/wallet-sdk-address-format', 'dist/index.js');
const { createKeystore } = await fromEngine('@midnightntwrk/wallet-sdk-unshielded-wallet', 'dist/index.js');
const { SubmissionError } = await fromEngine('@midnightntwrk/wallet-sdk-capabilities', 'dist/submission/index.js');

connectorSuite({
  set: 'beta',
  createDAppConnector,
  signatureScheme,
  toHistoryEntry,
  PartlySignedTransactionError,
  deriveUnshieldedAddress,
  deriveAllShieldedAddresses,
  deriveShieldedAddress,
  DustAddress,
  UnshieldedAddress,
  MidnightBech32m,
  ledger,
  createKeystore,
  SubmissionError,
  // The beta facade takes the wallet's secret keys on every call that spends.
  secretKeys: { shieldedSecretKeys: { tag: 'zswap' }, dustSecretKey: { tag: 'dust' } },
  // The beta engine reads a dApp's transaction with its ledger and hands the facade that.
  readsThroughFacade: false,
  handleHex: (handle: { serialize(): Uint8Array }) => Buffer.from(handle.serialize()).toString('hex'),
});
