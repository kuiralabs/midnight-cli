// A proving key of the account contract that can't be fetched: the account
// package's own artefact cache, as the rc engine installs it, fetching from a
// local server that answers 404 (the keys of a build not published) or not at
// all. Nothing reaches a chain.

import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyError, createHost, EXIT_GENERAL_ERROR } from '@kuiralabs/midnight-cli-core';
import { accountChainFor } from '../lib/grant/account-chain.ts';
import { accountKeysFailureOf } from '../lib/grant/account.ts';
import { AccountKeysUnavailableError } from '../lib/grant/account-errors.ts';
import { grantCodes } from '../commands/grant.codes.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';

// Its state root is the test's own; the engine picks its SDK set by the network.
const host = createHost({ engineLoader: loadInstalledEngine, paths: () => ({ stateRoot: path.join(cacheRoot, '.midnight'), home: cacheRoot }) });
const CIRCUIT = 'withdraw_shielded_with_jubjub';

let cacheRoot: string;
let server: Server | undefined;
beforeEach(() => { cacheRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-account-keys-'))); });
afterEach(async () => {
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/** A release server answering every file with `status`. */
async function release(status: number): Promise<string> {
  server = createServer((_req, res) => { res.statusCode = status; res.end(); });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

/** What reading the circuit's verifier key from the account package's cache, fetching from `source`, fails with. */
async function readFailure(source: string): Promise<unknown> {
  const { artefacts } = await accountChainFor(host.engines, 'undeployed');
  const cache = artefacts.artefactCache(cacheRoot, { source });
  return cache.provider().getVerifierKey(CIRCUIT).then(() => undefined, (err: unknown) => err);
}

describe('accountKeysFailureOf', () => {
  // Regression: grant deploy on a build whose keys are not published failed as UNKNOWN "Failed to read verifier key …".
  it('says a key the build\'s release does not have is not published, naming the key, the build and its compiler', async () => {
    const chain = await accountChainFor(host.engines, 'undeployed');
    const failure = await readFailure(await release(404));
    // As midnight-js reports it when it proves: its own error, the account package's as its cause.
    const wrapped = new Error(`Failed to read verifier key for Account#${CIRCUIT}`, { cause: failure });
    const keys = accountKeysFailureOf(wrapped, chain);
    expect(keys).toBeInstanceOf(AccountKeysUnavailableError);
    expect(keys!.file).toBe(`keys/${CIRCUIT}.verifier`);
    const compiler = JSON.parse(fs.readFileSync(path.join(chain.contract.ACCOUNT_BUILD, 'compiler', 'contract-info.json'), 'utf8'))['compiler-version'];
    expect(keys!.message).toBe(
      `The account contract's keys/${CIRCUIT}.verifier isn't available: the keys of this account build ${chain.artefacts.ACCOUNT_BUILD_ID} (compiled with compactc ${compiler}) are not published (${chain.artefacts.BUILD_RELEASE} answered HTTP 404). `
      + "mn grant needs them to deploy and to act on an account, and retrying won't help: use an mn release whose account build has its keys published.",
    );
    expect(classifyError(keys!, { code: (code) => grantCodes.find((d) => d.code === code) })).toEqual({ exitCode: EXIT_GENERAL_ERROR, errorCode: 'ACCOUNT_KEYS_UNAVAILABLE' });
  });

  it('says a fetch that failed otherwise could not be had, in the account package\'s words', async () => {
    const chain = await accountChainFor(host.engines, 'undeployed');
    const keys = accountKeysFailureOf(await readFailure(await release(500)), chain);
    expect(keys?.message).toMatch(new RegExp(`^The account contract's keys/${CIRCUIT}\\.verifier for this account build ${chain.artefacts.ACCOUNT_BUILD_ID} .* could not be had: could not fetch the proving artefact .*HTTP 500`));
  });

  it('leaves any other failure alone', async () => {
    const chain = await accountChainFor(host.engines, 'undeployed');
    expect(accountKeysFailureOf(new Error('Failed to read verifier key for Account#x'), chain)).toBeUndefined();
    expect(accountKeysFailureOf('nope', chain)).toBeUndefined();
  });
});
