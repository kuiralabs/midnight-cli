// A --json call's warnings: the notices it would show on stderr without
// --json, its own (ctx.warn) and its host's given while it runs, in its
// result as `warnings`, present only when there are some. Two calls at once
// each keep their own. The host runs its calls through the process guard,
// as mn's shell and MCP server do, which knows which call a notice comes from.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureCommand, runCommand, type RunnableDefinition } from '../lib/run-command.ts';
import type { CommandHandler } from '../lib/call-context.ts';
import { createHost, type Host } from '../lib/host.ts';
import { parseArgs } from '../lib/argv.ts';
import { installSdkProcessGuard, type SdkProcessGuard } from '../process/sdk-process-guard.ts';
import { sleep } from '../lib/sleep.ts';

const definitionOf = (handler: CommandHandler): RunnableDefinition => ({ shell: {}, load: async () => ({ default: handler }) });

let guard: SdkProcessGuard;
let host: Host;
const hostNotices: string[] = [];
beforeEach(() => {
  guard = installSdkProcessGuard();
  hostNotices.length = 0;
  host = createHost({ paths: { stateRoot: '/nonexistent/.midnight', home: '/nonexistent' }, sdkWarnings: guard.calls, notice: (line) => hostNotices.push(line) });
});
afterEach(() => guard.uninstall());

/** A command that warns `own`, has its host give the notice `fromHost` (after `delayMs`), and writes `{ done: true }`. */
const warning = (own: string, fromHost: string, delayMs = 0): RunnableDefinition => definitionOf(async (_args, ctx) => {
  ctx.warn(own);
  await sleep(delayMs);
  ctx.host.notice(`  \x1b[2m${fromHost}\x1b[0m`);
  ctx.diagnostics.line('test', 'a diagnostic line, never a warning');
  ctx.output.result({ done: true });
});

describe('the warnings of a --json call', () => {
  it('carry its own and its host\'s notices, without colour or indent, beside its result; the host still gets its notices', async () => {
    const result = await captureCommand(warning('Moved the store', 'Dust is read in WASM'), parseArgs(['x', '--verbose']), { host, text: () => {} });
    expect(result).toStrictEqual({ done: true, warnings: ['Moved the store', 'Dust is read in WASM'] });
    expect(hostNotices).toContain('  \x1b[2mDust is read in WASM\x1b[0m');
  });

  it('are left out when there are none', async () => {
    const quiet = definitionOf(async (_args, ctx) => { ctx.output.result({ done: true }); });
    expect(await captureCommand(quiet, parseArgs(['x']), { host, text: () => {} })).toStrictEqual({ done: true });
  });

  it('are each call\'s own when two run at once', async () => {
    const [first, second] = await Promise.all([
      captureCommand(warning('first', 'first host notice', 30), parseArgs(['x']), { host, text: () => {} }),
      captureCommand(warning('second', 'second host notice', 5), parseArgs(['x']), { host, text: () => {} }),
    ]);
    expect(first.warnings).toEqual(['first', 'first host notice']);
    expect(second.warnings).toEqual(['second', 'second host notice']);
  });

  it('without --json, a call\'s own warning is a line on its stderr, and its result has none', async () => {
    const stderr: string[] = [];
    const results: unknown[] = [];
    await runCommand(warning('Moved the store', 'from the host'), parseArgs(['x']), { host, output: { result: (d) => results.push(d), stdout: () => {}, stderr: (t) => stderr.push(t) } });
    expect(stderr).toEqual(['Moved the store\n']);
    expect(results).toEqual([{ done: true }]);
  });
});
