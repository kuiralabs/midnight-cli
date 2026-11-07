// `mn cache clear --network <name>` clears only a network's cache folder: a
// name that isn't a network is refused as a usage error before anything is
// deleted. It used to be joined onto the cache folder as given, so
// `--network ../wallets` deleted every wallet and `--network ..` the config and
// keystore, and `--network bogus` reported success.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../test-support/run-cli.ts';

let home: string;
let root: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mn-cache-clear-')));
  root = join(home, '.midnight');
  mkdirSync(join(root, 'wallets'), { recursive: true });
  writeFileSync(join(root, 'wallets', 'alice.json'), '{"sealed":"x"}\n');
  writeFileSync(join(root, 'wallets', 'bob.json'), '{"sealed":"y"}\n');
  writeFileSync(join(root, 'config.json'), '{"network":"undeployed"}\n');
  writeFileSync(join(root, 'keystore.json'), '{"check":"z"}\n');
  mkdirSync(join(home, 'elsewhere'));
  writeFileSync(join(home, 'elsewhere', 'keep.json'), '{}\n');
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const everyFileKept = () => {
  expect(readdirSync(join(root, 'wallets')).sort()).toStrictEqual(['alice.json', 'bob.json']);
  expect(existsSync(join(root, 'config.json'))).toBe(true);
  expect(existsSync(join(root, 'keystore.json'))).toBe(true);
  expect(existsSync(join(home, 'elsewhere', 'keep.json'))).toBe(true);
};

describe('mn cache clear --network', () => {
  it.each(['../wallets', '..', '../../elsewhere', 'bogus'])('refuses %s as INVALID_ARGS (exit 2) and deletes nothing', (network) => {
    const run = runCli(home, ['cache', 'clear', '--network', network, '--json']);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: true, code: 'INVALID_ARGS', message: expect.stringContaining(`Invalid network: "${network}"`) });
    everyFileKept();
  });

  it('clears a network it knows', () => {
    const cache = join(root, 'cache', 'undeployed');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'dust-abc.json'), '{}\n');
    const run = runCli(home, ['cache', 'clear', '--network', 'undeployed', '--json']);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toStrictEqual({ action: 'clear', scope: 'network', network: 'undeployed' });
    expect(readdirSync(cache)).toStrictEqual([]);
    everyFileKept();
  });
});
