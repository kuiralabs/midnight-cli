// An engine refuses to load when its SDK packages reach more than one copy of
// a WASM package, as an install that ignores mn's shrinkwrap can leave them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MixedSdkLayoutError, assertOneSdkCopy } from '../lib/sdk-layout.ts';

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
