// What a library has for the person at the terminal goes to the notices its
// host takes, never to stderr directly: a host that takes none drops it, and
// the CLI's host writes it to stderr as before. HOME is a temporary folder.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '@kuiralabs/midnight-cli-core';
import { loadInstalledEngine } from '../lib/installed-engines.ts';
import { unlockWallet } from '../lib/wallet-config.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { saveWalletConfig } from './helpers/plain-wallet.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-notices-'));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const plainWallet = (name: string): string =>
  saveWalletConfig({ seed: SEED, addresses: rcKeys.unshieldedAddresses(Buffer.from(SEED, 'hex')), createdAt: '2026-10-19T00:00:00.000Z' }, path.join(home, '.midnight', 'wallets', `${name}.json`));

describe('notices', () => {
  it("carry a library's warning to its host's notices when its caller gives no warn of its own, and nowhere when the host takes none", async () => {
    const lines: string[] = [];
    const wallet = plainWallet('notice-alice');
    await unlockWallet(wallet, { root: path.join(home, '.midnight'), host: createHost({ engineLoader: loadInstalledEngine }) });
    await unlockWallet(wallet, { root: path.join(home, '.midnight'), host: createHost({ notice: (line) => lines.push(line), engineLoader: loadInstalledEngine }) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/not protected: its seed is in plain text/);
  });

  it('reach stderr through the CLI, as before', () => {
    plainWallet('alice');
    const run = spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'src/wallet.ts'), 'wallet', 'seed', 'alice', '--json'], {
      cwd: home, encoding: 'utf8', timeout: 60_000, input: '', env: { ...process.env, HOME: home, NO_COLOR: '1', MN_NO_LOCAL_DETECT: '1' },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/Warning: wallet .*alice\.json is not protected/);
    // Starting the CLI through tsx takes seconds under a full parallel run: the test waits as long as its spawn does.
  }, 60_000);
});
