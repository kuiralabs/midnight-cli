// The account contract's proving artefacts read from a local folder, the way
// openGrantAccount hands the account package its source: the package's own
// cache, which takes a file only when it matches the build's manifest. A
// folder that is not this build's is refused, and mn reports it as
// ACCOUNT_KEYS_UNAVAILABLE naming the folder and where it was set.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyError, createHost } from '@kuiralabs/midnight-cli-core';
import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
import { accountChainOf } from '../lib/grant/account-chain.ts';
import { accountKeysFailureOf } from '../lib/grant/account-keys.ts';
import { AccountKeysUnavailableError } from '../lib/grant/account-errors.ts';
import { grantCodes } from '../commands/grant.codes.ts';
import { codeRegistry } from '../../../../test-support/core-codes.ts';
import { coreCodes } from '@kuiralabs/midnight-cli-core/commands';

// The account package as the rc engine installs it.
const chain = await accountChainOf(createRcEngine(createHost()));
const CODES = codeRegistry(coreCodes, grantCodes);
const FROM_CONFIG = { origin: 'config key account-artifacts' };

let work: string;
let source: string;
let cache: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-grant-artifacts-'));
  source = path.join(work, 'Account');
  fs.mkdirSync(path.join(source, 'keys'), { recursive: true });
  cache = path.join(work, 'cache');
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/** The verifier key of a circuit, read through the cache over `source`: what a deploy reads first. */
const readVerifier = (circuit: string) => chain.artefacts.artefactCache(cache, { source }).provider().getVerifierKey(circuit);

describe('the proving artefacts from a local folder', () => {
  it("are read from the folder, and one that is not this build's file is refused, naming the folder and where it was set", async () => {
    // As many bytes as the manifest says the build's file has, not its bytes.
    const manifest = JSON.parse(fs.readFileSync(path.join(chain.contract.ACCOUNT_BUILD, 'compiler', 'contract-manifest.json'), 'utf8')) as Record<string, Record<string, { size: number }>>;
    fs.writeFileSync(path.join(source, 'keys', 'deposit_unshielded.verifier'), Buffer.alloc(manifest.keys!['deposit_unshielded.verifier']!.size, 7));

    const err = await readVerifier('deposit_unshielded').then(() => undefined, (e: unknown) => e);
    const reported = accountKeysFailureOf(err, chain, { source, ...FROM_CONFIG });

    expect(reported).toBeInstanceOf(AccountKeysUnavailableError);
    expect(reported!.message).toContain(`could not be had from ${source} (config key account-artifacts)`);
    expect(reported!.message).toContain(`from ${path.join(source, 'keys', 'deposit_unshielded.verifier')}`);
    expect(reported!.message).toContain("its SHA-256 is not the manifest's: not this build's file, refused");
    expect(classifyError(reported!, CODES).errorCode).toBe('ACCOUNT_KEYS_UNAVAILABLE');
    // Nothing that isn't the build's is kept in the cache.
    expect(fs.existsSync(path.join(cache, chain.artefacts.ACCOUNT_BUILD_ID, 'keys', 'deposit_unshielded.verifier'))).toBe(false);
  });

  it('say which file the folder lacks', async () => {
    const err = await readVerifier('deposit_unshielded').then(() => undefined, (e: unknown) => e);

    expect(accountKeysFailureOf(err, chain, { source, ...FROM_CONFIG })!.message).toContain(`from ${path.join(source, 'keys', 'deposit_unshielded.verifier')}: not found`);
  });
});

describe('keys the release does not publish', () => {
  it('name the release and the setting that reads a local build instead', () => {
    const notPublished = new chain.errors.ArtefactFetchError(
      `could not fetch the proving artefact keys/deposit_unshielded.verifier from ${chain.artefacts.BUILD_RELEASE}deposit_unshielded.verifier: the server answered HTTP 404. Run the command again to retry; what was fetched before is kept.`,
      { cause: new Error('the server answered HTTP 404') },
    );

    const reported = accountKeysFailureOf(notPublished, chain)!;

    expect(reported.message).toContain(`are not published (${chain.artefacts.BUILD_RELEASE} answered HTTP 404)`);
    expect(reported.message).toContain('midnight config set account-artifacts <that folder>, or set MN_ACCOUNT_ARTIFACTS.');
  });
});
