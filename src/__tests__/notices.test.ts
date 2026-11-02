// What a library has for the person at the terminal goes to the notice sink
// its host sets, never to stderr directly: with no sink it is dropped, and
// the CLI's sink writes it to stderr as before. HOME is a temporary folder.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { notice, setNoticeSink } from '@kuiralabs/midnight-cli-core/lib/notices';
import { unlockWallet } from '../lib/wallet-config.ts';
import { deriveAllAddresses } from '@kuiralabs/midnight-engine-rc/derive-address';
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
  setNoticeSink(null);
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const plainWallet = (name: string): string =>
  saveWalletConfig({ seed: SEED, addresses: deriveAllAddresses(Buffer.from(SEED, 'hex')), createdAt: '2026-10-19T00:00:00.000Z' }, path.join(home, '.midnight', 'wallets', `${name}.json`));

describe('notices', () => {
  it('reach the sink that is set, and are dropped with none', () => {
    const lines: string[] = [];
    notice('before any sink');
    setNoticeSink((line) => lines.push(line));
    notice('one line');
    setNoticeSink(null);
    notice('after the sink is gone');
    expect(lines).toEqual(['one line']);
  });

  it("carry a library's warning when its caller gives no warn of its own", async () => {
    const lines: string[] = [];
    setNoticeSink((line) => lines.push(line));
    await unlockWallet(plainWallet('notice-alice'));
    expect(lines.join('\n')).toMatch(/not protected: its seed is in plain text/);
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
