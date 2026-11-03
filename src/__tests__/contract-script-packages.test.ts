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
  SCRIPT_PARTS,
  acquireOverlay as acquireOverlayFor,
  executeScript,
  releaseOverlay,
  overlayScriptPackages as overlayScriptPackagesFor,
  scriptRuntime,
  undoOverlay,
} from '../lib/contract/runner.ts';
import * as rcScripts from '@kuiralabs/midnight-engine-rc/contract-scripts';
import { SCRIPT_PACKAGES, packageFolder } from '@kuiralabs/midnight-engine-rc/contract-scripts';
import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
import { createHost } from '@kuiralabs/midnight-cli-core/lib/host';
import type { CallScript, DeployScript, StateScript } from '@kuiralabs/midnight-cli-core/lib/engine';

// An rc engine, for what every host's has alike: its keys, ledger and contracts.
const rcEngine = createRcEngine(createHost());

// The rc engine's scripts, with the parts the runner gives every engine.
const generateDeployScript = (opts: DeployScript & { dappDir?: string }): string => rcScripts.generateDeployScript(opts, SCRIPT_PARTS);
const generateCallScript = (opts: CallScript & { dappDir?: string }): string => rcScripts.generateCallScript(opts, SCRIPT_PARTS);
const generateStateScript = (opts: StateScript & { dappDir?: string }): string => rcScripts.generateStateScript(opts, SCRIPT_PARTS);
// The overlay of the rc engine's packages.
const RC_PACKAGES = { ...rcEngine.contracts.scripts, set: 'rc' };
const overlayScriptPackages = (userNodeModules: string) => overlayScriptPackagesFor(userNodeModules, RC_PACKAGES);
const acquireOverlay = (dir: string): void => acquireOverlayFor(dir, RC_PACKAGES);

import { platformPackageBinary } from '@kuiralabs/midnight-engine-rc/dust-sync-native';

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
  const importEach = (dapp: string, extra: string[] = []) => {
    const script = path.join(dapp, 'probe.mjs');
    const names = [...SCRIPT_PACKAGES, ...extra];
    fs.writeFileSync(script, `for (const p of ${JSON.stringify(names)}) await import(p);\nconsole.log('imported', ${names.length});`);
    const run = spawnSync(scriptRuntime(), [script], { cwd: dapp, encoding: 'utf8', timeout: 120_000 });
    fs.rmSync(script);
    return run;
  };
  // A package of the same installed tree that no generated script imports, as a witness might.
  const WITNESS_ONLY = '@midnight-ntwrk/midnight-js-protocol';

  it('with no node_modules gets a link to the installed tree, so a witness\'s other imports resolve too, and is left as it was', () => {
    const made = overlayScriptPackages(path.join(dir, 'node_modules'));
    expect(made).toHaveLength(1);
    expect(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()).toBe(true);
    const run = importEach(dir, [WITNESS_ONLY]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(`imported ${SCRIPT_PACKAGES.length + 1}`);

    undoOverlay(made);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('with a node_modules of its own but no Midnight scope gets the whole scope linked', () => {
    fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
    const made = overlayScriptPackages(path.join(dir, 'node_modules'));
    expect(fs.lstatSync(path.join(dir, 'node_modules', '@midnight-ntwrk')).isSymbolicLink()).toBe(true);
    const run = importEach(dir, [WITNESS_ONLY]);
    expect(run.status, run.stderr).toBe(0);

    undoOverlay(made);
    expect(fs.readdirSync(path.join(dir, 'node_modules'))).toEqual(['left-pad']);
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

  it('shares one overlay between runs at once: the first to finish leaves it for the other, the last undoes it', () => {
    acquireOverlay(dir);
    acquireOverlay(dir);
    releaseOverlay(dir);
    expect(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(importEach(dir).status).toBe(0);
    releaseOverlay(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a run whose holder died: the stale share is dropped and the overlay still undone', () => {
    acquireOverlay(dir);
    const record = path.join(dir, '.mn-overlay.json');
    const held = JSON.parse(fs.readFileSync(record, 'utf8')) as { pids: number[]; made: unknown[] };
    // A pid no live process has.
    fs.writeFileSync(record, JSON.stringify({ ...held, pids: [...held.pids, 2 ** 22 + 12345] }));
    releaseOverlay(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('links a scope whole only when one folder holds all its packages, and then nothing inside it', () => {
    // A tree holding @x/a, and @x/b found elsewhere (an install that hoisted it):
    // linking @x whole to the tree would leave @x/b out, so @x is a folder of the
    // dApp's own with a link to each, and the engine's install is left as it was.
    const tree = path.join(dir, 'tree', '@x');
    fs.mkdirSync(path.join(tree, 'a'), { recursive: true });
    const elsewhere = path.join(dir, 'elsewhere', '@x', 'b');
    fs.mkdirSync(elsewhere, { recursive: true });
    const dapp = path.join(dir, 'dapp', 'node_modules');
    fs.mkdirSync(dapp, { recursive: true });
    const packages = { set: 'rc', packages: ['@x/a', '@x/b'], packageFolder: (name: string) => (name === '@x/a' ? path.join(tree, 'a') : elsewhere) };
    const made = overlayScriptPackagesFor(dapp, packages);
    expect(made.map((m) => [path.relative(dir, m.path), m.kind])).toEqual([
      [path.join('dapp', 'node_modules', '@x'), 'folder'],
      [path.join('dapp', 'node_modules', '@x', 'a'), 'link'],
      [path.join('dapp', 'node_modules', '@x', 'b'), 'link'],
    ]);
    expect(fs.realpathSync(path.join(dapp, '@x', 'b'))).toBe(fs.realpathSync(elsewhere));
    expect(fs.readdirSync(tree)).toEqual(['a']);
    undoOverlay(made);
    expect(fs.readdirSync(dapp)).toEqual([]);
  });

  it('gives a dApp with no node_modules a folder of links when the packages sit in more than one tree', () => {
    // As in a workspace: the engine's own copies nested under it, a package it shares hoisted to the root.
    const nested = path.join(dir, 'engine', 'node_modules');
    fs.mkdirSync(path.join(nested, '@x', 'a'), { recursive: true });
    const hoisted = path.join(dir, 'root', 'node_modules', 'ws');
    fs.mkdirSync(hoisted, { recursive: true });
    const dapp = path.join(dir, 'dapp', 'node_modules');
    fs.mkdirSync(path.dirname(dapp), { recursive: true });
    const packages = { set: 'beta', packages: ['@x/a', 'ws'], packageFolder: (name: string) => (name === 'ws' ? hoisted : path.join(nested, '@x', 'a')) };
    const made = overlayScriptPackagesFor(dapp, packages);
    expect(made.map((m) => [path.relative(dir, m.path), m.kind])).toEqual([
      [path.join('dapp', 'node_modules'), 'folder'],
      [path.join('dapp', 'node_modules', '@x'), 'link'],
      [path.join('dapp', 'node_modules', 'ws'), 'link'],
    ]);
    expect(fs.realpathSync(path.join(dapp, 'ws'))).toBe(fs.realpathSync(hoisted));
    expect(fs.readdirSync(nested)).toEqual(['@x']);
    undoOverlay(made);
    expect(fs.readdirSync(path.dirname(dapp))).toEqual([]);
  });

  it('refuses another SDK set\'s packages while a run uses its overlay, and replaces it once none does', () => {
    acquireOverlay(dir);
    const beta = { ...RC_PACKAGES, set: 'beta' };
    expect(() => acquireOverlayFor(dir, beta)).toThrow('uses the rc SDK set\'s packages, and this one needs the beta set\'s');
    // The rc run dies: its share is stale, so the beta run undoes the rc overlay and makes its own.
    const record = path.join(dir, '.mn-overlay.json');
    const held = JSON.parse(fs.readFileSync(record, 'utf8')) as { pids: number[]; made: unknown[]; set: string };
    fs.writeFileSync(record, JSON.stringify({ ...held, pids: [2 ** 22 + 12345] }));
    acquireOverlayFor(dir, beta);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toMatchObject({ set: 'beta', pids: [process.pid] });
    releaseOverlay(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('with no Node to run under, refuses before writing anything to the dApp', async () => {
    await expect(executeScript({ dir, script: 'console.log(1)', packages: RC_PACKAGES, findRuntime: () => { throw new NoNodeRuntimeError(); } })).rejects.toThrow(NoNodeRuntimeError);
    expect(fs.readdirSync(dir)).toEqual([]);
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
