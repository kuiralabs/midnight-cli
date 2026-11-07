// Where mn's one passphrase comes from, and how it is held to being one: from
// MN_PASSPHRASE, else typed at a terminal without echo, else a clear refusal;
// once set, the keystore's check refuses any other passphrase, so no secret
// is ever sealed under a second one.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WrongPassphraseError, FILE_MODE, createHost, sealSecret } from '@kuiralabs/midnight-cli-core';
import { createTerminalPrompter } from '@kuiralabs/midnight-cli-core/ui';
import {
  NoPassphraseError,
  PASSPHRASE_ENV,
  MIN_PASSPHRASE_LENGTH,
  establishPassphrase,
  isPassphraseSet,
  passphraseForNewSecret,
  readPassphrase,
  unlockPassphrase,
} from '../lib/passphrase.ts';
import { stateRootIn } from '../../../../test-support/state-root-in.ts';

// The host the tests' calls run in: nobody to ask, notices dropped.
const host = createHost();

const PASSPHRASE = 'correct horse battery staple';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-passphrase-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// A terminal that types `lines` and records what mn writes to it.
const terminal = (...lines: string[]) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  const typeNext = (): void => { const line = lines.shift(); if (line !== undefined) input.write(`${line}\n`); };
  return { io: { env: {}, prompter: createTerminalPrompter({ input, output, isTTY: true }), typeNext }, written: () => written };
};

describe('reading the passphrase', () => {
  it('takes MN_PASSPHRASE when it is set, asking nothing', async () => {
    const value = await readPassphrase(null, { env: { [PASSPHRASE_ENV]: PASSPHRASE } });
    expect(value).toBe(PASSPHRASE);
  });

  it('asks at a terminal, without echoing what is typed', async () => {
    const { io, written } = terminal(PASSPHRASE);
    const reading = readPassphrase(io.prompter, io);
    io.typeNext();
    expect(await reading).toBe(PASSPHRASE);
    expect(written()).toContain('Passphrase');
    expect(written()).not.toContain(PASSPHRASE);
  });

  it('asks twice when setting it, and refuses two that differ', async () => {
    const { io } = terminal(PASSPHRASE, 'something else');
    const reading = readPassphrase(io.prompter, { ...io, confirm: true });
    io.typeNext();
    setTimeout(io.typeNext, 10);
    await expect(reading).rejects.toThrow(/do not match/);
  });

  it('refuses where it can neither read the variable nor ask', async () => {
    await expect(readPassphrase(null, { env: {} })).rejects.toThrow(NoPassphraseError);
  });
});

describe('the one passphrase', () => {
  it('is set once, in an owner-only file, and then known to be set', () => {
    expect(isPassphraseSet(stateRootIn(home))).toBe(false);
    establishPassphrase(stateRootIn(home), PASSPHRASE);
    expect(isPassphraseSet(stateRootIn(home))).toBe(true);
    const marker = fs.readdirSync(path.join(home, '.midnight')).find((name) => name.startsWith('keystore'));
    expect(marker).toBeDefined();
    expect(fs.statSync(path.join(home, '.midnight', marker as string)).mode & 0o777).toBe(FILE_MODE);
  });

  it('unlocks with the passphrase it was set with', async () => {
    establishPassphrase(stateRootIn(home), PASSPHRASE);
    expect(await unlockPassphrase(host, stateRootIn(home), { env: { [PASSPHRASE_ENV]: PASSPHRASE } })).toBe(PASSPHRASE);
  });

  it('refuses any other passphrase once set', async () => {
    establishPassphrase(stateRootIn(home), PASSPHRASE);
    await expect(unlockPassphrase(host, stateRootIn(home), { env: { [PASSPHRASE_ENV]: 'another one' } })).rejects.toThrow(WrongPassphraseError);
  });

  it('checks a changed MN_PASSPHRASE afresh, never taking the one checked before', async () => {
    establishPassphrase(stateRootIn(home), PASSPHRASE);
    await unlockPassphrase(host, stateRootIn(home), { env: { [PASSPHRASE_ENV]: PASSPHRASE } });
    await expect(unlockPassphrase(host, stateRootIn(home), { env: { [PASSPHRASE_ENV]: 'another one' } })).rejects.toThrow(WrongPassphraseError);
  });

  it('is not set a second time over the first', () => {
    establishPassphrase(stateRootIn(home), PASSPHRASE);
    expect(() => establishPassphrase(stateRootIn(home), 'another one')).toThrow(/already set/);
  });
});

describe('a new secret', () => {
  it('sets the passphrase on a machine with none, and is sealed under it', async () => {
    const passphrase = await passphraseForNewSecret(host, stateRootIn(home), { env: { [PASSPHRASE_ENV]: PASSPHRASE } });
    expect(passphrase).toBe(PASSPHRASE);
    expect(isPassphraseSet(stateRootIn(home))).toBe(true);
  });

  it(`refuses a new passphrase shorter than ${MIN_PASSPHRASE_LENGTH} characters, setting nothing`, async () => {
    await expect(passphraseForNewSecret(host, stateRootIn(home), { env: { [PASSPHRASE_ENV]: 'too short' } })).rejects.toThrow(/at least/);
    expect(isPassphraseSet(stateRootIn(home))).toBe(false);
  });

  it('takes the passphrase already set, and no other', async () => {
    establishPassphrase(stateRootIn(home), PASSPHRASE);
    await expect(passphraseForNewSecret(host, stateRootIn(home), { env: { [PASSPHRASE_ENV]: 'another passphrase' } })).rejects.toThrow(WrongPassphraseError);
  });
});


// The keystore is what holds mn to one passphrase. Deleted, with sealed
// wallets left, the next new secret used to set whatever passphrase it was
// given, and mn could open none of the wallets sealed under the first.
describe('sealed wallets whose keystore is gone', () => {
  const sealWalletAt = (root: string, name: string, passphrase: string) => {
    const dir = path.join(root, 'wallets');
    fs.mkdirSync(dir, { recursive: true });
    const sealed = sealSecret(Buffer.from(JSON.stringify({ seed: 'ab'.repeat(32) }), 'utf8'), passphrase, 'wallet');
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ addresses: {}, createdAt: '2026-11-07T00:00:00.000Z', sealed }));
  };

  it('refuses a new passphrase that does not open them, setting none', async () => {
    const root = stateRootIn(home);
    sealWalletAt(root, 'alice', PASSPHRASE);
    await expect(passphraseForNewSecret(host, root, { env: { [PASSPHRASE_ENV]: 'a different passphrase' } })).rejects.toThrow(WrongPassphraseError);
    await expect(passphraseForNewSecret(host, root, { env: { [PASSPHRASE_ENV]: 'a different passphrase' } })).rejects.toThrow(/keystore .* is missing/);
    expect(isPassphraseSet(root)).toBe(false);
  });

  it('restores the keystore with the passphrase they were sealed under', async () => {
    const root = stateRootIn(home);
    sealWalletAt(root, 'alice', PASSPHRASE);
    expect(await passphraseForNewSecret(host, root, { env: { [PASSPHRASE_ENV]: PASSPHRASE } })).toBe(PASSPHRASE);
    expect(isPassphraseSet(root)).toBe(true);
    await expect(unlockPassphrase(createHost(), root, { env: { [PASSPHRASE_ENV]: 'a different passphrase' } })).rejects.toThrow(WrongPassphraseError);
  });

  it('says how to restore it when a sealed wallet is opened', async () => {
    const root = stateRootIn(home);
    sealWalletAt(root, 'alice', PASSPHRASE);
    await expect(unlockPassphrase(createHost(), root, { env: { [PASSPHRASE_ENV]: PASSPHRASE } })).rejects.toThrow(/keystore .* is missing.*midnight wallet protect/);
  });
});
