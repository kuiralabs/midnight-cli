// A wallet file as mn writes it: its addresses readable by anyone, its seed
// and mnemonic sealed under mn's passphrase. Nothing secret is in the file in
// the clear; what is sealed opens only with the passphrase; a wallet an
// earlier mn wrote in plain text still works, with a warning, until it is
// sealed in place, keeping everything it held.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WrongPassphraseError, FILE_MODE, createHost } from '@kuiralabs/midnight-cli-core';
import { PASSPHRASE_ENV, establishPassphrase } from '../lib/passphrase.ts';
import { loadWalletConfig, protectAllWallets, sealWalletInPlace, unlockWallet, writeSealedWallet } from '../lib/wallet-config.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { stateRootIn } from './helpers/state-root-in.ts';
import { loadInstalledEngine } from '../lib/installed-engines.ts';

// The host the tests' calls run in: nobody to ask, notices dropped, and an engine of its own from the engines the CLI ships.
const host = createHost({ engineLoader: loadInstalledEngine });

const SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'correct horse battery staple';
const PUBLIC = {
  addresses: rcKeys.unshieldedAddresses(Buffer.from(SEED, 'hex')),
  shieldedAddresses: rcKeys.shieldedAddresses(Buffer.from(SEED, 'hex')),
  createdAt: '2026-10-19T00:00:00.000Z',
};

let home: string;
let file: string;
const withPassphrase = (passphrase: string) => ({ root: stateRootIn(home), host, source: { env: { [PASSPHRASE_ENV]: passphrase } } });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sealed-wallet-'));
  file = path.join(home, '.midnight', 'wallets', 'alice.json');
  establishPassphrase(stateRootIn(home), PASSPHRASE);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a sealed wallet', () => {
  it('holds no secret in the clear, owner-only', () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED, mnemonic: MNEMONIC }, PASSPHRASE);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(SEED);
    expect(text).not.toContain('abandon');
    expect(fs.statSync(file).mode & 0o777).toBe(FILE_MODE);
  });

  it('shows its addresses without the passphrase', async () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE);
    const config = await loadWalletConfig(file, host.engines);
    expect(config.addresses).toEqual(PUBLIC.addresses);
    expect(config.shieldedAddresses).toEqual(PUBLIC.shieldedAddresses);
    expect(config.isSealed).toBe(true);
    expect(config).not.toHaveProperty('seed');
  });

  it('opens its seed and mnemonic with the passphrase', async () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED, mnemonic: MNEMONIC }, PASSPHRASE);
    const wallet = await unlockWallet(file, withPassphrase(PASSPHRASE));
    expect(wallet.seed).toBe(SEED);
    expect(wallet.mnemonic).toBe(MNEMONIC);
  });

  it('is refused with another passphrase', async () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE);
    await expect(unlockWallet(file, withPassphrase('not the passphrase'))).rejects.toThrow(WrongPassphraseError);
  });

  it('is never written over an existing wallet', () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE);
    expect(() => writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE)).toThrow(/already exists/);
  });
});

describe('a wallet an earlier mn wrote in plain text', () => {
  const writePlain = (): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ seed: SEED, mnemonic: MNEMONIC, ...PUBLIC }, null, 2), { mode: FILE_MODE });
  };

  it('still opens, saying it is not protected', async () => {
    writePlain();
    const warnings: string[] = [];
    const wallet = await unlockWallet(file, { root: stateRootIn(home), host, warn: (line) => warnings.push(line) });
    expect(wallet.seed).toBe(SEED);
    expect((await loadWalletConfig(file, host.engines)).isSealed).toBe(false);
    expect(warnings.join('\n')).toMatch(/not protected[\s\S]*midnight wallet protect/);
  });

  it('is sealed in place, keeping its seed, mnemonic and addresses, with nothing left in the clear', async () => {
    writePlain();
    await sealWalletInPlace(file, PASSPHRASE, host.engines);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(SEED);
    expect(text).not.toContain('abandon');
    expect(await loadWalletConfig(file, host.engines)).toMatchObject({ ...PUBLIC, isSealed: true });
    const wallet = await unlockWallet(file, withPassphrase(PASSPHRASE));
    expect(wallet.seed).toBe(SEED);
    expect(wallet.mnemonic).toBe(MNEMONIC);
  });

  it('is left as it was when it is already sealed', async () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE);
    const before = fs.readFileSync(file, 'utf8');
    await sealWalletInPlace(file, PASSPHRASE, host.engines);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('protecting every wallet', () => {
  const writePlainAt = (name: string, seed: string): string => {
    const at = path.join(home, '.midnight', 'wallets', `${name}.json`);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, JSON.stringify({ seed, ...PUBLIC }, null, 2), { mode: FILE_MODE });
    return at;
  };
  const OTHER_SEED = '11'.repeat(32);

  it('seals each plain-text wallet, leaves a sealed one, and says which was which', async () => {
    const bob = writePlainAt('bob', OTHER_SEED);
    const carol = writePlainAt('carol', SEED);
    writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE);
    const report = await protectAllWallets(stateRootIn(home), PASSPHRASE, host.engines);
    expect(report).toEqual([
      { name: 'alice', file, sealedNow: false },
      { name: 'bob', file: bob, sealedNow: true },
      { name: 'carol', file: carol, sealedNow: true },
    ]);
    expect(fs.readFileSync(bob, 'utf8')).not.toContain(OTHER_SEED);
    expect((await unlockWallet(bob, withPassphrase(PASSPHRASE))).seed).toBe(OTHER_SEED);
  });

  it('protects nothing, and says so, where there is no wallet', async () => {
    expect(await protectAllWallets(stateRootIn(home), PASSPHRASE, host.engines)).toEqual([]);
  });
});

