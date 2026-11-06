// Running a command from its definition (src/lib/run-command.ts), as a
// program that mounts our commands does: runCommand for a command line,
// captureCommand for an MCP tool, toolDescription for the tool's listing. The
// commands here are the test's own; mn's shell and MCP server run theirs
// through the same two functions, and their tests check the installed ones.

import { describe, expect, it } from 'vitest';
import { captureCommand, runCommand, toolDescription, type CommandRun, type RunnableDefinition } from '../lib/run-command.ts';
import { listedNames } from '../lib/agent-guidance.ts';
import { createCommandRegistry, type CommandDefinition } from '../lib/command-definition.ts';
import type { CallContext, CommandHandler, CommandOutcome } from '../lib/call-context.ts';
import { SecondResultError } from '../lib/call-context.ts';
import { CancelledError, CommandFailedError } from '../lib/errors.ts';
import { parseArgs, type ParsedArgs } from '../lib/argv.ts';
import type { Payer } from '../lib/payer.ts';
import type { Spinner } from '../ui/spinner.ts';
import { testHost } from '../../../../test-support/test-host.ts';

/** A definition whose handler is `handler`, with what the shell does around it. */
const definitionOf = (handler: CommandHandler, shell: CommandDefinition['shell'] = {}): RunnableDefinition => ({ shell, load: async () => ({ default: handler }) });

const noArgs = (): ParsedArgs => ({ command: 'x', subcommand: undefined, positionals: [], flags: {} });

/** A capture run on a test host, its text for the person kept in `text`. */
function captureRun(run: Partial<CommandRun> = {}): CommandRun & { text: (t: string) => void; said: string[] } {
  const said: string[] = [];
  return { host: testHost(), ...run, said, text: (t) => { said.push(t); } };
}

describe('runCommand', () => {
  // Test commands whose handlers record the context they were given.
  const received: { args: ParsedArgs; ctx: CallContext }[] = [];
  const loaded: string[] = [];
  const results: unknown[] = [];
  const notices: string[] = [];
  const payer = { name: 'test payer' } as unknown as Payer;
  const protector = { name: 'test protector' };
  const command = (name: string, shell: CommandDefinition['shell'], outcome?: CommandOutcome): RunnableDefinition => ({
    shell,
    load: async () => {
      loaded.push(name);
      return { default: async (args, ctx) => { received.push({ args, ctx }); ctx.output.result({ ran: name }); return outcome; } };
    },
  });
  const controller = new AbortController();
  const output = {
    result: (data: Readonly<Record<string, unknown>>) => { results.push(data); },
    stdout: () => {},
    stderr: (text: string) => { notices.push(text); },
  };
  const given = { host: testHost(), signal: controller.signal, output, payer, protectors: [protector] };
  const run = async (definition: RunnableDefinition, argv: string[] = ['x', '--json'], call: Parameters<typeof runCommand>[2] = given) => {
    received.length = 0; loaded.length = 0; results.length = 0; notices.length = 0;
    const args = parseArgs(argv);
    const outcome = await runCommand(definition, args, call);
    return { args, call: received[0]!, outcome };
  };

  it('gives the handler its call\'s signal and output, and the payer and protectors only when the definition asks', async () => {
    const plain = await run(command('plain', {}));
    expect(plain.call.args).toBe(plain.args);
    expect(plain.call.ctx.signal).toBe(controller.signal);
    expect(plain.call.ctx.payer).toBeUndefined();
    expect(plain.call.ctx.protectors).toBeUndefined();
    expect(results).toStrictEqual([{ ran: 'plain' }]);
    const paying = await run(command('paying', { payer: true }));
    expect(paying.call.ctx.payer).toBe(payer);
    expect(paying.call.ctx.protectors).toBeUndefined();
    const protecting = await run(command('protecting', { protectors: true }));
    expect(protecting.call.ctx.payer).toBeUndefined();
    expect(protecting.call.ctx.protectors).toStrictEqual([protector]);
  });

  it('calls a payer or protectors loader only for a command whose definition asks for it', async () => {
    const asked: string[] = [];
    const loaders = { ...given, payer: async () => { asked.push('payer'); return payer; }, protectors: async () => { asked.push('protectors'); return [protector]; } };
    await run(command('plain', {}), ['x'], loaders);
    expect(asked).toStrictEqual([]);
    const paying = await run(command('paying', { payer: true }), ['x'], loaders);
    expect(paying.call.ctx.payer).toBe(payer);
    const protecting = await run(command('protecting', { protectors: true }), ['x'], loaders);
    expect(protecting.call.ctx.protectors).toStrictEqual([protector]);
    expect(asked).toStrictEqual(['payer', 'protectors']);
  });

  it('runs a command that asks for a payer without one when none is given: the handler says what it needs', async () => {
    const paying = await run(command('paying', { payer: true }), ['x'], { host: testHost(), output });
    expect(paying.call.ctx.payer).toBeUndefined();
  });

  it('gives the handler the configuration the host gives when the call starts, and --verbose', async () => {
    const { ctx } = (await run(command('plain', {}))).call;
    expect(ctx.config.paths).toStrictEqual(given.host.paths());
    expect(ctx.config.settings).toStrictEqual(given.host.settings());
    expect(ctx.diagnostics.isVerbose).toBe(false);
    expect((await run(command('plain', {}), ['x', '--verbose'])).call.ctx.diagnostics.isVerbose).toBe(true);
  });

  it('gives every handler a signal, one never cancelled when the run gives none', async () => {
    const { ctx } = (await run(command('plain', {}), ['x'], { host: testHost(), output })).call;
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
  });

  it('returns the exit code the handler gives', async () => {
    expect((await run(command('failing', {}, { exitCode: 3 }))).outcome).toStrictEqual({ exitCode: 3 });
    expect((await run(command('plain', {}))).outcome).toBeUndefined();
  });

  it('never starts a call already cancelled: CancelledError, the handler not run', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(run(command('plain', {}), ['x'], { ...given, signal: cancelled.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(received).toStrictEqual([]);
    expect(results).toStrictEqual([]);
  });

  it('writes a notice to the output\'s stderr before the handler loads', async () => {
    await run(command('noticed', { notice: 'deprecated\n' }));
    expect(notices).toStrictEqual(['deprecated\n']);
    expect(loaded).toStrictEqual(['noticed']);
    expect(results).toStrictEqual([{ ran: 'noticed' }]);
  });

  it('refuses an unavailable command with its message, loading nothing', async () => {
    await expect(run(command('refused', { unavailable: 'not now' }))).rejects.toThrow(new Error('not now'));
    expect(loaded).toStrictEqual([]);
  });

  // Regression: a command's spinners drew on the process's stderr, so a program mounting the commands got them on its
  // terminal whatever output it gave.
  it('draws the command\'s spinners through the run\'s output, never on the process\'s stderr', async () => {
    const drawn: string[] = [];
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      await runCommand(definitionOf(async (_args, ctx) => { ctx.progress.start('Syncing...').stop('Synced'); }), noArgs(), { host: testHost(), output: { ...output, stderr: (text) => { drawn.push(text); } } });
    } finally {
      process.stderr.write = original;
    }
    expect(drawn.join('')).toContain('Synced');
    expect(written.join('')).not.toContain('Synced');
  });

  it('sends what the command\'s spinners say to onProgress', async () => {
    const said: string[] = [];
    await runCommand(definitionOf(async (_args, ctx) => { ctx.progress.start('Syncing...').stop('Synced'); }), noArgs(), { host: testHost(), output, onProgress: (m) => said.push(m) });
    expect(said).toStrictEqual(['Syncing...', 'Synced']);
  });
});

describe('captureCommand', () => {
  it('fails a command that returns a non-zero exit code, with the result it wrote, and passes one that returns 0', async () => {
    const failing = definitionOf(async (_args, ctx) => { ctx.output.result({ overall: 'fail' }); return { exitCode: 1 }; });
    const err = await captureCommand(failing, parseArgs(['test', 'run']), captureRun()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandFailedError);
    expect((err as CommandFailedError).code).toBe('COMMAND_FAILED');
    expect((err as CommandFailedError).exitCode).toBe(1);
    expect((err as CommandFailedError).result).toStrictEqual({ overall: 'fail' });

    const passing = definitionOf(async (_args, ctx) => { ctx.output.result({ overall: 'pass' }); return { exitCode: 0 }; });
    expect(await captureCommand(passing, parseArgs(['test', 'run']), captureRun())).toStrictEqual({ overall: 'pass' });
  });

  it('returns {} for a command that wrote no result', async () => {
    expect(await captureCommand(definitionOf(async () => {}), noArgs(), captureRun())).toStrictEqual({});
  });

  it('refuses an unavailable command, and sends a notice to the run\'s text', async () => {
    await expect(captureCommand(definitionOf(async () => {}, { unavailable: 'not now' }), noArgs(), captureRun())).rejects.toThrow('not now');
    const run = captureRun();
    await captureCommand(definitionOf(async () => {}, { notice: 'deprecated\n' }), noArgs(), run);
    expect(run.said).toStrictEqual(['deprecated\n']);
  });

  describe('agent-slim mode', () => {
    const captureArgs = (sink: { args?: ParsedArgs }) => definitionOf(async (a: ParsedArgs) => { sink.args = a; });

    it('sets json: true and _minimal: true by default', async () => {
      const sink: { args?: ParsedArgs } = {};
      await captureCommand(captureArgs(sink), noArgs(), captureRun());
      expect(sink.args?.flags.json).toBe(true);
      expect(sink.args?.flags._minimal).toBe(true);
    });

    it('does not override an explicitly-set _minimal flag', async () => {
      const sink: { args?: ParsedArgs } = {};
      await captureCommand(captureArgs(sink), { ...noArgs(), flags: { _minimal: true, _full: true } }, captureRun());
      expect(sink.args?.flags._minimal).toBe(true);
      expect(sink.args?.flags._full).toBe(true);
    });
  });

  describe('progress and cancellation', () => {
    it('sends what a command\'s spinner says to onProgress, a --json command\'s silent spinner too', async () => {
      const said: string[] = [];
      await captureCommand(definitionOf(async (_args, ctx) => {
        const quiet = ctx.progress.silent();
        quiet.update('Starting mn serve...');
        quiet.stop('mn serve ready (port 9932)');
        const shown = ctx.progress.start('Checking balance on undeployed...');
        shown.update('Syncing transactions... 40%');
        shown.log('fetching keys/deposit_shielded.prover (11 MB), once, from github.com');
        shown.stop('Synced 3 transactions');
      }), noArgs(), captureRun({ onProgress: (message) => said.push(message) }));
      expect(said).toEqual([
        'Starting mn serve...',
        'mn serve ready (port 9932)',
        'Checking balance on undeployed...',
        'Syncing transactions... 40%',
        'fetching keys/deposit_shielded.prover (11 MB), once, from github.com',
        'Synced 3 transactions',
      ]);
    });

    it('sends nothing once the run is over, even when it failed', async () => {
      const said: string[] = [];
      let left: Spinner | undefined;
      await expect(captureCommand(definitionOf(async (_args, ctx) => {
        left = ctx.progress.silent();
        throw new Error('refused');
      }), noArgs(), captureRun({ onProgress: (message) => said.push(message) }))).rejects.toThrow('refused');
      left?.update('said after the run');
      expect(said).toEqual([]);
    });

    it('tells the command which of its spinners runs now, and none once it stops', async () => {
      await captureCommand(definitionOf(async (_args, ctx) => {
        expect(ctx.progress.active()).toBeNull();
        const spinner = ctx.progress.start('Syncing wallet...');
        expect(ctx.progress.active()).toBe(spinner);
        spinner.stop('Wallet synced');
        expect(ctx.progress.active()).toBeNull();
      }), noArgs(), captureRun());
    });

    it('hands the command the run\'s signal', async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      await captureCommand(definitionOf(async (_args, ctx) => { seen = ctx.signal; }), noArgs(), captureRun({ signal: controller.signal }));
      expect(seen).toBe(controller.signal);
    });

    it('never starts a call already cancelled: CancelledError, the command not run', async () => {
      const controller = new AbortController();
      controller.abort();
      let ran = false;
      const err = await captureCommand(definitionOf(async () => { ran = true; }), noArgs(), captureRun({ signal: controller.signal })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CancelledError);
      expect(ran).toBe(false);
    });
  });

  // Regression: the capture target was one module global. Two calls
  // in one server that overlapped shared it: the first to finish cleared it,
  // and the other's result fell through to stdout, the MCP protocol channel,
  // while its call returned {}.
  describe('two calls at once', () => {
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      return { open, opened };
    };

    it('each keeps its own result when they finish in the opposite order they started', async () => {
      const first = gate();
      const second = gate();
      const a = captureCommand(definitionOf(async (_args, ctx) => { await first.opened; ctx.output.result({ call: 'a' }); }), noArgs(), captureRun());
      const b = captureCommand(definitionOf(async (_args, ctx) => { await second.opened; ctx.output.result({ call: 'b' }); }), noArgs(), captureRun());
      second.open();
      expect(await b).toEqual({ call: 'b' });
      first.open();
      expect(await a).toEqual({ call: 'a' });
    });

    // Regression: the progress target and the active spinner were
    // module globals. The second call to start took the target, so what the
    // first call's spinners said went to the second call's client, and the
    // first call's went nowhere once the second ended.
    it('each keeps its own progress: what one call\'s spinners say never reaches the other\'s client', async () => {
      const first = gate();
      const second = gate();
      const saidA: string[] = [];
      const saidB: string[] = [];
      let activeInA: Spinner | null | undefined;
      const a = captureCommand(definitionOf(async (_args, ctx) => {
        const spinner = ctx.progress.silent();
        spinner.update('a: before b starts');
        await first.opened;
        spinner.update('a: while b runs');
        activeInA = ctx.progress.active();
        spinner.stop('a: done');
      }), noArgs(), captureRun({ onProgress: (message) => saidA.push(message) }));
      const b = captureCommand(definitionOf(async (_args, ctx) => {
        const spinner = ctx.progress.start('b: started');
        first.open();
        await second.opened;
        spinner.stop('b: done');
      }), noArgs(), captureRun({ onProgress: (message) => saidB.push(message) }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      second.open();
      await Promise.all([a, b]);
      expect(saidA).toEqual(['a: before b starts', 'a: while b runs', 'a: done']);
      expect(saidB).toEqual(['b: started', 'b: done']);
      expect(activeInA).toBeNull();
    });

    it('keeps a result as it was written: a change the command makes after is not seen', async () => {
      const result = await captureCommand(definitionOf(async (_args, ctx) => {
        const data: Record<string, unknown> = { balance: '1' };
        ctx.output.result(data);
        data.balance = '2';
      }), noArgs(), captureRun());
      expect(result).toEqual({ balance: '1' });
    });

    it('refuses a second result in one call', async () => {
      await expect(captureCommand(definitionOf(async (_args, ctx) => {
        ctx.output.result({ call: 'first' });
        ctx.output.result({ call: 'second' });
      }), noArgs(), captureRun())).rejects.toThrow(SecondResultError);
    });

    it('sends the command\'s text for the person to the run\'s text, its stdout and stderr alike', async () => {
      const run = captureRun();
      await captureCommand(definitionOf(async (_args, ctx) => {
        ctx.output.stdout('shown\n');
        ctx.output.stderr('chrome\n');
        ctx.output.result({ ok: true });
      }), noArgs(), run);
      expect(run.said).toStrictEqual(['shown\n', 'chrome\n']);
    });
  });
});

describe('toolDescription', () => {
  // A tool whose command declares codes is checked with mn's installed tools (src/__tests__/mcp-registry-tools.test.ts).
  it('is the definition\'s description when the command declares no codes', () => {
    const registry = createCommandRegistry([{
      name: 'thing', order: 1, flags: [], needsWalletSdk: false, shell: {}, errors: { codes: [] },
      load: async () => ({ default: async () => {} }),
      mcp: { tools: [{ name: 'thing_show', description: 'Show a thing.', params: [], argv: { flags: [] }, order: 1 }] },
    }], []);
    expect(toolDescription(registry, registry.tools[0]!)).toBe('Show a thing.');
  });

  it('names sets in a sentence', () => {
    expect(listedNames(['network'])).toBe('network');
    expect(listedNames(['network', 'wallet'])).toBe('network and wallet');
    expect(listedNames(['network', 'wallet', 'engine'])).toBe('network, wallet and engine');
  });
});
