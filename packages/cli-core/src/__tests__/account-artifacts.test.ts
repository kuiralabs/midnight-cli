// Where mn grant gets the account contract's proving artefacts: MN_ACCOUNT_ARTIFACTS,
// else the config key account-artifacts, else the build's release; each source
// checked as it is given, so a wrong one is refused with where it came from.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCOUNT_ARTIFACTS_KEY, InvalidAccountArtifactsSourceError, checkAccountArtifactsSource, resolveAccountArtifactsSource } from '../lib/account-artifacts.ts';
import { getConfigValue, loadCliConfig, setConfigValue, unsetConfigValue } from '../lib/cli-config.ts';
import { settingsFromEnvironment } from '../lib/settings.ts';
import { classifyError } from '../lib/exit-codes.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';

let work: string;
let build: string;
let other: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-account-artifacts-'));
  // A build's folder holds keys/ and zkir/.
  build = path.join(work, 'Account');
  fs.mkdirSync(path.join(build, 'keys'), { recursive: true });
  other = path.join(work, 'Other');
  fs.mkdirSync(path.join(other, 'keys'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const refusal = (run: () => unknown): InvalidAccountArtifactsSourceError => {
  try { run(); } catch (err) { return err as InvalidAccountArtifactsSourceError; }
  throw new Error('expected a refusal');
};

describe('checkAccountArtifactsSource', () => {
  it('takes an http(s) URL as it is, and a build folder by its absolute path or file: URL', () => {
    expect(checkAccountArtifactsSource('https://example.org/build-1/', 'x')).toBe('https://example.org/build-1/');
    expect(checkAccountArtifactsSource(` ${build} `, 'x')).toBe(build);
    expect(checkAccountArtifactsSource(pathToFileURL(build).href, 'x')).toBe(build);
  });

  it.each([
    ['managed/Account', 'a folder must be given by its absolute path'],
    ['ftp://example.org/build/', 'a URL must be http or https'],
    ['/nowhere/at/all', 'there is no folder there'],
  ])('refuses %s, saying why and where it was given', (value, reason) => {
    const err = refusal(() => checkAccountArtifactsSource(value, 'MN_ACCOUNT_ARTIFACTS'));
    expect(err).toBeInstanceOf(InvalidAccountArtifactsSourceError);
    expect(err.message).toContain(`can't be had from ${JSON.stringify(value)} (MN_ACCOUNT_ARTIFACTS): ${reason}.`);
    expect(err).toMatchObject({ source: value, origin: 'MN_ACCOUNT_ARTIFACTS' });
    expect(classifyError(err, CORE_CODES).errorCode).toBe('INVALID_ARGS');
  });

  it('refuses a folder with no keys/: not a build of the contract', () => {
    const empty = path.join(work, 'empty');
    fs.mkdirSync(empty);
    expect(refusal(() => checkAccountArtifactsSource(empty, 'x')).message).toContain('it has no keys/ folder, so it is not a build of the account contract');
  });
});

describe('resolveAccountArtifactsSource', () => {
  it('takes MN_ACCOUNT_ARTIFACTS over the config key, the config key over the release', () => {
    const settings = settingsFromEnvironment({ MN_ACCOUNT_ARTIFACTS: build });
    expect(resolveAccountArtifactsSource(settings, { [ACCOUNT_ARTIFACTS_KEY]: other })).toEqual({ source: build, origin: 'MN_ACCOUNT_ARTIFACTS' });
    expect(resolveAccountArtifactsSource(settingsFromEnvironment({}), { [ACCOUNT_ARTIFACTS_KEY]: other })).toEqual({ source: other, origin: 'config key account-artifacts' });
    expect(resolveAccountArtifactsSource(settingsFromEnvironment({}), {})).toEqual({ source: undefined, origin: "the account build's release" });
  });

  it('refuses a configured folder that has gone, naming the config key', () => {
    fs.rmSync(other, { recursive: true });
    expect(refusal(() => resolveAccountArtifactsSource(settingsFromEnvironment({}), { [ACCOUNT_ARTIFACTS_KEY]: other })).message).toContain('(config key account-artifacts): there is no folder there');
  });
});

describe('the account-artifacts config key', () => {
  it('is set for every network, read back, refused when it is not a source, and unset back to the release', () => {
    const configDir = path.join(work, 'mn');
    setConfigValue(ACCOUNT_ARTIFACTS_KEY, build, configDir);
    expect(getConfigValue(ACCOUNT_ARTIFACTS_KEY, configDir)).toBe(build);
    expect(loadCliConfig(configDir)[ACCOUNT_ARTIFACTS_KEY]).toBe(build);

    expect(refusal(() => setConfigValue(ACCOUNT_ARTIFACTS_KEY, 'relative/Account', configDir)).message).toContain('(config key account-artifacts): a folder must be given by its absolute path');
    expect(getConfigValue(ACCOUNT_ARTIFACTS_KEY, configDir)).toBe(build);
    expect(() => setConfigValue(ACCOUNT_ARTIFACTS_KEY, build, configDir, 'preview')).toThrow('--network only applies');

    unsetConfigValue(ACCOUNT_ARTIFACTS_KEY, configDir);
    expect(getConfigValue(ACCOUNT_ARTIFACTS_KEY, configDir)).toBe('(not set)');
    expect(resolveAccountArtifactsSource(settingsFromEnvironment({}), loadCliConfig(configDir)).source).toBeUndefined();
  });
});
