// Folders and files mn writes are its user's alone. Created by mn they always
// were; ones an earlier mn or the user left wider are narrowed when mn writes
// to them, and a narrower mode is never widened.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureOwnerOnlyDir, narrowToOwnerOnly } from '../lib/owner-only.ts';
import { writeJsonDurably } from '../lib/durable-file.ts';
import { saveWalletCache } from '../lib/wallet-cache.ts';
import { bindCachesToIndexer } from '../lib/cache-indexer.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-owner-only-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const modeOf = (target: string) => fs.statSync(target).mode & 0o777;
const wideDir = (target: string) => { fs.mkdirSync(target, { recursive: true }); fs.chmodSync(target, 0o755); return target; };

describe('ensureOwnerOnlyDir', () => {
  it('makes a missing folder 0700', () => {
    ensureOwnerOnlyDir(path.join(dir, 'new'));
    expect(modeOf(path.join(dir, 'new'))).toBe(0o700);
  });

  it('narrows a 0755 folder to 0700', () => {
    ensureOwnerOnlyDir(wideDir(path.join(dir, 'wide')));
    expect(modeOf(path.join(dir, 'wide'))).toBe(0o700);
  });

  it('never widens a narrower folder', () => {
    const narrow = path.join(dir, 'narrow');
    fs.mkdirSync(narrow);
    fs.chmodSync(narrow, 0o500);
    ensureOwnerOnlyDir(narrow);
    expect(modeOf(narrow)).toBe(0o500);
    fs.chmodSync(narrow, 0o700);
  });
});

describe('narrowToOwnerOnly', () => {
  it('narrows a 0644 file to 0600', () => {
    const file = path.join(dir, 'f.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o644);
    narrowToOwnerOnly(file);
    expect(modeOf(file)).toBe(0o600);
  });
});

describe('the writers that use them', () => {
  it('writeJsonDurably narrows the folder it writes in', () => {
    const folder = wideDir(path.join(dir, 'wallets'));
    writeJsonDurably(path.join(folder, 'alice.json'), {});
    expect(modeOf(folder)).toBe(0o700);
  });

  it('saveWalletCache and bindCachesToIndexer narrow the cache folders', async () => {
    const root = path.join(dir, 'root');
    wideDir(path.join(root, 'cache', 'undeployed'));
    fs.chmodSync(path.join(root, 'cache'), 0o755);
    bindCachesToIndexer('undeployed', 'ws://127.0.0.1:1/api/v4/graphql/ws', root);
    expect(modeOf(path.join(root, 'cache'))).toBe(0o700);
    expect(modeOf(path.join(root, 'cache', 'undeployed'))).toBe(0o700);

    fs.chmodSync(path.join(root, 'cache'), 0o755);
    fs.chmodSync(path.join(root, 'cache', 'undeployed'), 0o755);
    const serialized = { serializeState: async () => 's' };
    await saveWalletCache('mn_addr_undeployed1abc', 'undeployed', { shielded: serialized, unshielded: serialized, dust: serialized }, root);
    expect(modeOf(path.join(root, 'cache'))).toBe(0o700);
    expect(modeOf(path.join(root, 'cache', 'undeployed'))).toBe(0o700);
  });
});
