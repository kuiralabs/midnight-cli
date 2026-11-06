// A call's context (src/lib/call-context.ts): what each call's
// handler is given. Its output takes one result and passes each piece on as it
// comes; its diagnostics show lines only when the call is verbose; a call
// already cancelled never starts.

import { describe, expect, it } from 'vitest';
import { SecondResultError, callDiagnostics, callOutput, createCallContext, runHandler, type CallContext } from '../lib/call-context.ts';
import { CancelledError } from '../lib/errors.ts';
import { parseArgs } from '../lib/argv.ts';
import { createHost } from '../lib/host.ts';
import { settingsFromEnvironment } from '../lib/settings.ts';
import { type Payer } from '../lib/payer.ts';
import { testHost } from '../../../../test-support/test-host.ts';

const recordingSink = () => {
  const seen: string[] = [];
  return {
    seen,
    sink: {
      result: (data: Readonly<Record<string, unknown>>) => { seen.push(`result ${JSON.stringify(data)}`); },
      stdout: (text: string) => { seen.push(`stdout ${text}`); },
      stderr: (text: string) => { seen.push(`stderr ${text}`); },
    },
  };
};

describe("a call's output", () => {
  it('passes the result and the text on as they come, in order', () => {
    const { seen, sink } = recordingSink();
    const output = callOutput(sink);
    output.stderr('working');
    output.result({ ok: true });
    output.stdout('done');
    expect(seen).toEqual(['stderr working', 'result {"ok":true}', 'stdout done']);
  });

  it('takes one result: a second throws and reaches nowhere', () => {
    const { seen, sink } = recordingSink();
    const output = callOutput(sink);
    output.result({ n: 1 });
    expect(() => output.result({ n: 2 })).toThrow(SecondResultError);
    expect(seen).toEqual(['result {"n":1}']);
  });

  it('counts results per call: two calls each take their own', () => {
    const { seen, sink } = recordingSink();
    callOutput(sink).result({ call: 'a' });
    callOutput(sink).result({ call: 'b' });
    expect(seen).toEqual(['result {"call":"a"}', 'result {"call":"b"}']);
  });
});

describe("a call's diagnostics", () => {
  it('shows a timestamped line through its writer when verbose', () => {
    const lines: string[] = [];
    const diagnostics = callDiagnostics(true, (line) => lines.push(line));
    diagnostics.line('balance', 'address=mn_addr_x');
    expect(diagnostics.isVerbose).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[\d\d:\d\d:\d\d\.\d{3}\] balance: address=mn_addr_x/);
  });

  it('shows nothing when not verbose', () => {
    const lines: string[] = [];
    const diagnostics = callDiagnostics(false, (line) => lines.push(line));
    diagnostics.line('balance', 'address=mn_addr_x');
    expect(diagnostics.isVerbose).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("a call's context", () => {
  const payer = { name: 'test payer' } as unknown as Payer;

  it('holds its signal, --verbose, the payer and protectors given, its host, and the configuration the host gives at its start', () => {
    const controller = new AbortController();
    const { sink } = recordingSink();
    const host = createHost({ paths: { stateRoot: '/call-state', home: '/call-home' }, settings: settingsFromEnvironment({ MN_NO_LOCAL_DETECT: '1' }) });
    const ctx = createCallContext({ host, args: parseArgs(['balance', '--verbose']), signal: controller.signal, output: sink, payer, protectors: ['p'] });
    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.diagnostics.isVerbose).toBe(true);
    expect(ctx.payer).toBe(payer);
    expect(ctx.protectors).toEqual(['p']);
    expect(ctx.host).toBe(host);
    expect(ctx.config).toStrictEqual({ settings: settingsFromEnvironment({ MN_NO_LOCAL_DETECT: '1' }), paths: { stateRoot: '/call-state', home: '/call-home' } });
  });

  it("writes its verbose lines through its own host's notices", () => {
    const { sink } = recordingSink();
    const lines: string[] = [];
    const ctx = createCallContext({ host: createHost({ paths: { stateRoot: '/s', home: '/h' }, notice: (line) => lines.push(line) }), args: parseArgs(['balance', '--verbose']), signal: new AbortController().signal, output: sink });
    ctx.diagnostics.line('sync', 'started');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('started');
  });

  it('gives two calls of two hosts each its own configuration', () => {
    const { sink } = recordingSink();
    const call = (stateRoot: string) => createCallContext({ host: createHost({ paths: { stateRoot, home: '/h' } }), args: parseArgs(['info']), signal: new AbortController().signal, output: sink });
    expect([call('/a').config.paths.stateRoot, call('/b').config.paths.stateRoot]).toEqual(['/a', '/b']);
  });

  it('has no payer or protectors when none are given', () => {
    const { sink } = recordingSink();
    const ctx = createCallContext({ host: testHost(), args: parseArgs(['info']), signal: new AbortController().signal, output: sink });
    expect('payer' in ctx).toBe(false);
    expect('protectors' in ctx).toBe(false);
    expect(ctx.diagnostics.isVerbose).toBe(false);
  });

  it('runs the handler and gives back the exit code it returns', async () => {
    const { sink } = recordingSink();
    const args = parseArgs(['test', 'run']);
    const ctx = createCallContext({ host: testHost(), args, signal: new AbortController().signal, output: sink });
    let given: CallContext | undefined;
    const outcome = await runHandler(async (_args, c) => { given = c; return { exitCode: 1 }; }, args, ctx);
    expect(outcome).toEqual({ exitCode: 1 });
    expect(given).toBe(ctx);
  });

  it('never starts a call already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { seen, sink } = recordingSink();
    const args = parseArgs(['info']);
    const ctx = createCallContext({ host: testHost(), args, signal: controller.signal, output: sink });
    let ran = false;
    await expect(runHandler(async (_a, c) => { ran = true; c.output.result({}); }, args, ctx)).rejects.toThrow(CancelledError);
    expect(ran).toBe(false);
    expect(seen).toEqual([]);
  });
});
