// The price a contract script writes for its transaction before proving it:
// read by the runner as soon as its line is whole, so mn shows it while the
// script goes on, and kept out of the script's progress lines. The scripts
// here are real Node processes run by executeScript.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransactionPrice } from '@kuiralabs/midnight-cli-core';
import { SCRIPT_PRELUDE, SCRIPT_PRICED_MARKER, SCRIPT_PROVING_MARKER, executeScript, scriptPriceOf } from '../lib/contract/runner.ts';
import { SCRIPT_NOTICE_MARKER } from '../lib/contract/private-state-lock.ts';

const NO_PACKAGES = { packages: [], packageFolder: () => null, set: 'rc' };
const WIRE = { committed: '1236000000000000', have: '5000000000000000', covers: true, waitMs: 0, marginBlocks: 3 };
const PRICE: TransactionPrice = { committed: 1_236_000_000_000_000n, have: 5_000_000_000_000_000n, covers: true, waitMs: 0, marginBlocks: 3 };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('scriptPriceOf', () => {
  it('reads the price on the marked line, the last when there are several', () => {
    const later = { ...WIRE, committed: '2000' };
    const stderr = `Deploying contract...\n${SCRIPT_PRICED_MARKER} ${JSON.stringify(WIRE)}\nProving...\n${SCRIPT_PRICED_MARKER} ${JSON.stringify(later)}\n`;
    expect(scriptPriceOf(stderr)).toEqual({ ...PRICE, committed: 2000n });
  });

  it('is undefined when the script wrote none', () => {
    expect(scriptPriceOf('Deploying contract...\nDeploy complete\n')).toBeUndefined();
  });

  it('refuses a marked line that is not a price', () => {
    expect(() => scriptPriceOf(`${SCRIPT_PRICED_MARKER} {not json\n`)).toThrow('A contract script reported a price that isn\'t JSON');
    expect(() => scriptPriceOf(`${SCRIPT_PRICED_MARKER} {"committed":"1"}\n`)).toThrow('with something that is not a price');
  });
});

describe('a script\'s price, as it runs', () => {
  it('gives each proving line\'s time to onProving, and keeps the lines out of the progress', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mn-price-'));
    const script = SCRIPT_PRELUDE + `
process.stderr.write('\\n${SCRIPT_PROVING_MARKER} 15000\\n');
process.stderr.write('\\n${SCRIPT_PROVING_MARKER} 30000\\n');
process.stderr.write('\\n${SCRIPT_PROVING_MARKER} not-a-time\\n');
process.stderr.write('Proven\\n');
console.log('{}');
`;
    const proving: number[] = [];
    const messages: string[] = [];
    await executeScript({ dir, script, overlaySdk: false, packages: NO_PACKAGES, onProving: (ms) => proving.push(ms), onMessage: (m) => messages.push(m) });
    expect(proving).toEqual([15_000, 30_000]);
    expect(messages.join('\n')).not.toContain(SCRIPT_PROVING_MARKER);
  });

  it('reads a notice cut across two reads whole, and keeps it out of the progress lines', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mn-price-'));
    const line = `${SCRIPT_NOTICE_MARKER} ${JSON.stringify('The private-state store is in use: waiting.')}`;
    const script = SCRIPT_PRELUDE + `
process.stderr.write(${JSON.stringify(line.slice(0, 10))});
await new Promise((r) => setTimeout(r, 100));
process.stderr.write(${JSON.stringify(line.slice(10) + '\n')});
process.stderr.write('Calling increment...');
console.log('{}');
`;
    const notices: string[] = [];
    const messages: string[] = [];
    await executeScript({ dir, script, overlaySdk: false, packages: NO_PACKAGES, onNotice: (n) => notices.push(n), onMessage: (m) => messages.push(m) });
    expect(notices).toEqual(['The private-state store is in use: waiting.']);
    // The last line, written with no newline, still reaches the progress when the script ends.
    expect(messages).toEqual(['Calling increment...']);
  });

  it('reaches onPriced as soon as its line is whole, though written in two pieces, while the script goes on', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mn-price-'));
    const line = `${SCRIPT_PRICED_MARKER} ${JSON.stringify(WIRE)}`;
    const half = Math.floor(line.length / 2);
    // Two writes 100 ms apart: two pipe reads. The script ends a second after the price.
    const script = SCRIPT_PRELUDE + `
process.stderr.write('Deploying contract...\\n');
process.stderr.write(${JSON.stringify(line.slice(0, half))});
await new Promise((r) => setTimeout(r, 100));
process.stderr.write(${JSON.stringify(line.slice(half) + '\n')});
await new Promise((r) => setTimeout(r, 1000));
process.stderr.write('Proving...\\n');
console.log('{"contractAddress":"ab"}');
`;
    const priced: Array<{ price: TransactionPrice; at: number }> = [];
    const messages: string[] = [];
    const out = await executeScript({ dir, script, overlaySdk: false, packages: NO_PACKAGES, onPriced: (price) => priced.push({ price, at: Date.now() }), onMessage: (m) => messages.push(m) });
    const ended = Date.now();

    expect(out).toBe('{"contractAddress":"ab"}');
    expect(priced.map((p) => p.price)).toEqual([PRICE]);
    expect(ended - priced[0]!.at).toBeGreaterThan(500);
    // The progress lines never show the price's line, nor a piece of it.
    expect(messages).toEqual(['Deploying contract...', 'Proving...']);
  });

  it('fails the run when the marked line is not a price', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mn-price-'));
    const script = SCRIPT_PRELUDE + `process.stderr.write(${JSON.stringify(`${SCRIPT_PRICED_MARKER} {"committed":"1"}\n`)});\nconsole.log('{}');\n`;
    await expect(executeScript({ dir, script, overlaySdk: false, packages: NO_PACKAGES, onPriced: () => {} })).rejects.toThrow('with something that is not a price');
  });
});
