// The contract runner finds each package its scripts need by name, wherever
// it is installed, and links it into a dApp laid out unlike ours; the list of
// packages matches what the scripts import; scripts run under Node whatever
// runtime hosts mn; and the sidecar's platform package is found from a folder
// it is installed under. Temporary folders only; nothing reaches a chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NoNodeRuntimeError,
  SCRIPT_PACKAGES,
  generateCallScript,
  generateDeployScript,
  generateStateScript,
  overlayScriptPackages,
  packageFolder,
  scriptRuntime,
  undoOverlay,
} from '../lib/contract/runner.ts';
import { platformPackageBinary } from '../lib/dust-sync-native.ts';

const NETWORK = { indexer: 'http://localhost:28088/api/v4/graphql', indexerWS: 'ws://localhost:28088/api/v4/graphql/ws', node: 'ws://localhost:29944', proofServer: 'http://localhost:26300', networkId: 'Undeployed' };
let dir: string;

beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-script-packages-'))); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Every bare specifier a script imports statically. */
const bareImports = (script: string): string[] =>
  [...script.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!)
    .filter((s) => !s.startsWith('.') && !s.startsWith('node:') && !s.startsWith('/'));

describe('the packages the scripts need', () => {
  it('are exactly what the deploy, call and state scripts import, and the compact runtime', () => {
    const base = { dappDir: dir, networkConfig: NETWORK, managedDir: path.join(dir, 'managed', 'counter'), contractName: 'counter', servePort: 9932 };
    const imported = new Set([
      ...bareImports(generateDeployScript({ ...base, args: [] })),
      ...bareImports(generateCallScript({ ...base, contractAddress: 'ab'.repeat(32), circuit: 'increment', args: [] })),
      ...bareImports(generateStateScript({ dappDir: dir, networkConfig: NETWORK, managedDir: base.managedDir, contractName: 'counter', contractAddress: 'ab'.repeat(32) })),
      // The user's compiled contract imports it.
      '@midnight-ntwrk/compact-runtime',
    ]);
    expect([...imported].sort()).toEqual([...SCRIPT_PACKAGES].sort());
  });

  it('are each found by name, as an installed package folder', () => {
    for (const name of SCRIPT_PACKAGES) {
      const folder = packageFolder(name);
      expect(folder, name).not.toBeNull();
      expect(JSON.parse(fs.readFileSync(path.join(folder!, 'package.json'), 'utf8')).name).toBe(name);
    }
    expect(packageFolder('@midnight-ntwrk/no-such-package')).toBeNull();
  });
});

describe('a dApp laid out unlike ours', () => {
  const importEach = (dapp: string) => {
    const script = path.join(dapp, 'probe.mjs');
    fs.writeFileSync(script, `for (const p of ${JSON.stringify(SCRIPT_PACKAGES)}) await import(p);\nconsole.log('imported', ${SCRIPT_PACKAGES.length});`);
    return spawnSync(scriptRuntime(), [script], { cwd: dapp, encoding: 'utf8', timeout: 120_000 });
  };

  it('with no node_modules gets one holding only links to the packages, and is left as it was', () => {
    const made = overlayScriptPackages(path.join(dir, 'node_modules'));
    expect(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'node_modules')).sort()).toEqual(['@midnight-ntwrk', 'ws']);
    const run = importEach(dir);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(`imported ${SCRIPT_PACKAGES.length}`);

    undoOverlay(made);
    fs.rmSync(path.join(dir, 'probe.mjs'));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('that pins a package keeps its own, gets the rest, and keeps its own afterwards', () => {
    const pinned = path.join(dir, 'node_modules', '@midnight-ntwrk', 'compact-runtime');
    fs.mkdirSync(pinned, { recursive: true });
    fs.writeFileSync(path.join(pinned, 'package.json'), JSON.stringify({ name: '@midnight-ntwrk/compact-runtime', version: '0.0.0-pinned', type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(pinned, 'index.js'), 'export const pinned = true;');

    const made = overlayScriptPackages(path.join(dir, 'node_modules'));
    expect(made.map((m) => path.relative(dir, m.path))).not.toContain(path.join('node_modules', '@midnight-ntwrk', 'compact-runtime'));
    expect(fs.lstatSync(path.join(dir, 'node_modules', '@midnight-ntwrk', 'midnight-js-contracts')).isSymbolicLink()).toBe(true);

    undoOverlay(made);
    expect(fs.readdirSync(path.join(dir, 'node_modules', '@midnight-ntwrk'))).toEqual(['compact-runtime']);
    expect(fs.readFileSync(path.join(pinned, 'index.js'), 'utf8')).toBe('export const pinned = true;');
  });
});

describe('the runtime a script runs under', () => {
  it('is the Node running mn', () => {
    expect(scriptRuntime({ execPath: '/opt/node/bin/node', isNode: true }, '')).toBe('/opt/node/bin/node');
  });

  it('under another runtime, is the first node on PATH, and refuses without one', () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'), '');
    expect(scriptRuntime({ execPath: '/opt/bun/bin/bun', isNode: false }, [path.join(dir, 'empty'), bin].join(path.delimiter))).toBe(path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
    expect(() => scriptRuntime({ execPath: '/opt/bun/bin/bun', isNode: false }, path.join(dir, 'empty'))).toThrow(NoNodeRuntimeError);
  });
});

describe("the sidecar's platform package", () => {
  it('is found from a folder it is installed under, and is null where it is not', () => {
    const exe = process.platform === 'win32' ? 'dust-sync.exe' : 'dust-sync';
    const pkg = path.join(dir, 'node_modules', '@nel349', `dust-sync-${process.platform}-${process.arch}`);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: `@nel349/dust-sync-${process.platform}-${process.arch}`, version: '0.0.0' }));
    fs.writeFileSync(path.join(pkg, exe), '');
    const from = pathToFileURL(path.join(dir, 'app', 'index.js')).href;

    expect(platformPackageBinary(from)).toBe(path.join(pkg, exe));
    expect(platformPackageBinary(pathToFileURL(path.join(os.tmpdir(), 'nowhere', 'index.js')).href)).toBeNull();
  });
});
