// An engine refuses to load when its SDK packages reach more than one copy of
// a WASM package, as an install that ignores mn's shrinkwrap can leave them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MixedSdkLayoutError, NotInstalledAsShippedError, assertInstalledAsShipped, assertOneSdkCopy, shippedTreeDrift } from '../lib/sdk-layout.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sdk-layout-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A package at `at` with `dependencies`. */
function pkg(at: string, name: string, dependencies: Record<string, string> = {}): string {
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }));
  return at;
}

describe('an engine\'s SDK layout', () => {
  it('passes when every SDK package reaches the engine\'s own ledger', () => {
    const engine = pkg(path.join(dir, 'node_modules', 'engine'), 'engine', { ledger: '1', facade: '1' });
    pkg(path.join(engine, 'node_modules', 'ledger'), 'ledger');
    pkg(path.join(engine, 'node_modules', 'facade'), 'facade', { ledger: '1' });
    expect(() => assertOneSdkCopy('the test engine', engine, ['facade'], ['ledger'])).not.toThrow();
  });

  it('refuses, saying how to install mn, when a package reaches a ledger of its own', () => {
    const engine = pkg(path.join(dir, 'node_modules', 'engine'), 'engine', { ledger: '1', facade: '1' });
    pkg(path.join(engine, 'node_modules', 'ledger'), 'ledger');
    // As a hoisting installer leaves it: the facade at the top, with another ledger beside it.
    pkg(path.join(dir, 'node_modules', 'facade'), 'facade', { ledger: '2' });
    pkg(path.join(dir, 'node_modules', 'facade', 'node_modules', 'ledger'), 'ledger');
    fs.rmSync(path.join(engine, 'node_modules', 'facade'), { recursive: true, force: true });
    const refusal = (() => { try { assertOneSdkCopy('the test engine', engine, ['facade'], ['ledger']); } catch (error) { return error; } })();
    expect(refusal).toBeInstanceOf(MixedSdkLayoutError);
    expect((refusal as Error).message).toContain('the test engine\'s SDK packages reach 2 copies of ledger');
    expect((refusal as Error).message).toContain('Install mn with npm: npm install -g midnight-wallet-cli');
  });

  it('counts no copy for a package that doesn\'t use the WASM package', () => {
    const engine = pkg(path.join(dir, 'node_modules', 'engine'), 'engine', { ledger: '1', utils: '1' });
    pkg(path.join(engine, 'node_modules', 'ledger'), 'ledger');
    pkg(path.join(dir, 'node_modules', 'utils'), 'utils');
    pkg(path.join(dir, 'node_modules', 'ledger'), 'ledger');
    expect(() => assertOneSdkCopy('the test engine', engine, ['utils'], ['ledger'])).not.toThrow();
  });
});

// Whether an engine is installed as the tree its npm-shrinkwrap.json describes: npm nests or hoists that tree and
// passes; an installer that resolves the ranges again (bun's) fails before any SDK module loads.
describe('an engine installed as shipped', () => {
  /** A package `name`@`version` at `at`, with `dependencies` (name to range). */
  const at = (dir: string, name: string, version: string, dependencies: Record<string, string> = {}): string => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, dependencies }));
    return dir;
  };
  // The engine's shrinkwrap: it needs a@1.0.0 and b@2.0.0; a needs b@^1, which the shrinkwrap nests under a.
  const SHRINKWRAP = {
    packages: {
      '': { name: 'engine', version: '0.1.0', dependencies: { a: '1.0.0', b: '2.0.0' } },
      'node_modules/a': { version: '1.0.0', dependencies: { b: '^1.0.0' } },
      'node_modules/a/node_modules/b': { version: '1.4.0' },
      'node_modules/b': { version: '2.0.0' },
      'node_modules/dev-only': { version: '9.0.0', dev: true },
    },
  };
  const engineAt = (dir: string): string => {
    const engine = at(dir, 'engine', '0.1.0', { a: '1.0.0', b: '2.0.0' });
    fs.writeFileSync(path.join(engine, 'npm-shrinkwrap.json'), JSON.stringify(SHRINKWRAP));
    return engine;
  };

  it('is not checked where the engine ships no shrinkwrap (a workspace checkout)', () => {
    const engine = at(path.join(dir, 'node_modules', 'engine'), 'engine', '0.1.0', { a: '1.0.0' });
    expect(shippedTreeDrift(engine)).toBeNull();
    expect(() => assertInstalledAsShipped('the test engine', engine)).not.toThrow();
  });

  it('passes the tree as npm installs a dependency\'s shrinkwrap: nested under the engine', () => {
    const engine = engineAt(path.join(dir, 'node_modules', 'engine'));
    at(path.join(engine, 'node_modules', 'a'), 'a', '1.0.0', { b: '^1.0.0' });
    at(path.join(engine, 'node_modules', 'a', 'node_modules', 'b'), 'b', '1.4.0');
    at(path.join(engine, 'node_modules', 'b'), 'b', '2.0.0');
    expect(shippedTreeDrift(engine)).toEqual([]);
  });

  it('passes the same tree hoisted, as npm lays it out under a package that ships its own shrinkwrap (mn)', () => {
    const engine = engineAt(path.join(dir, 'node_modules', 'engine'));
    at(path.join(dir, 'node_modules', 'a'), 'a', '1.0.0', { b: '^1.0.0' });
    at(path.join(dir, 'node_modules', 'a', 'node_modules', 'b'), 'b', '1.4.0');
    at(path.join(dir, 'node_modules', 'b'), 'b', '2.0.0');
    expect(shippedTreeDrift(engine)).toEqual([]);
  });

  it('finds a dependency resolved again to another version, and refuses with MIXED_SDK_LAYOUT, naming npm', () => {
    const engine = engineAt(path.join(dir, 'node_modules', 'engine'));
    at(path.join(dir, 'node_modules', 'a'), 'a', '1.0.0', { b: '^1.0.0' });
    at(path.join(dir, 'node_modules', 'a', 'node_modules', 'b'), 'b', '1.4.0');
    at(path.join(dir, 'node_modules', 'b'), 'b', '2.1.0');
    expect(shippedTreeDrift(engine)).toEqual([{ from: '.', name: 'b', found: '2.1.0', shipped: '2.0.0' }]);
    const refusal = (() => { try { assertInstalledAsShipped('the test engine', engine); } catch (error) { return error; } })();
    expect(refusal).toBeInstanceOf(NotInstalledAsShippedError);
    expect((refusal as NotInstalledAsShippedError).code).toBe('MIXED_SDK_LAYOUT');
    expect((refusal as Error).message).toContain('the test engine isn\'t installed as it was tested: 1 of its dependencies');
    expect((refusal as Error).message).toContain('Install with npm 11 or older');
  });

  // As bun's installer leaves graphql-tag: sharing the top-level graphql instead of the one nested for it.
  it('finds a package that shares a top-level copy where the shrinkwrap nests its own', () => {
    const engine = engineAt(path.join(dir, 'node_modules', 'engine'));
    at(path.join(dir, 'node_modules', 'a'), 'a', '1.0.0', { b: '^1.0.0' });
    at(path.join(dir, 'node_modules', 'b'), 'b', '2.0.0');
    expect(shippedTreeDrift(engine)).toEqual([{ from: 'node_modules/a', name: 'b', found: '2.0.0', shipped: '1.4.0' }]);
  });

  it('finds a dependency that is missing', () => {
    const engine = engineAt(path.join(dir, 'node_modules', 'engine'));
    at(path.join(dir, 'node_modules', 'b'), 'b', '2.0.0');
    expect(shippedTreeDrift(engine)).toEqual([{ from: '.', name: 'a', found: null, shipped: '1.0.0' }]);
  });
});
