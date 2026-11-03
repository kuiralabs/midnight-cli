// The beta engine's failures as it reports them: helpers/engine-boundary-suite.ts,
// with the SDK's error classes from the beta engine's own copies, as its code
// resolves them; the repository's root holds the rc set's.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBetaEngine } from '@kuiralabs/midnight-engine-beta';
import { resolvedPackageFolder } from '@kuiralabs/midnight-cli-core/lib/sdk-layout';
import { engineBoundarySuite } from './helpers/engine-boundary-suite.ts';

const ENGINE_DIR = new URL('../../packages/engine-beta', import.meta.url).pathname;
/** A module of a package as the beta engine resolves it. */
const fromEngine = async (name: string, entry: string) => import(pathToFileURL(join(resolvedPackageFolder(ENGINE_DIR, name)!, entry)).href);

const { SubmissionError } = await fromEngine('@midnightntwrk/wallet-sdk-capabilities', 'dist/submission/index.js');
const { ProvingError } = await fromEngine('@midnightntwrk/wallet-sdk-capabilities', 'dist/proving/index.js');
const { InsufficientFundsError: NoCoinsCoverIt } = await fromEngine('@midnightntwrk/wallet-sdk-capabilities', 'dist/index.js');
const { WalletError } = await fromEngine('@midnightntwrk/wallet-sdk-dust-wallet', 'dist/v1/index.js');

engineBoundarySuite({
  set: 'beta',
  createEngine: createBetaEngine,
  SubmissionError,
  ProvingError,
  InsufficientFundsError: WalletError.InsufficientFundsError,
  couldNotBalance: (tokenType) => new NoCoinsCoverIt(tokenType).message,
});
