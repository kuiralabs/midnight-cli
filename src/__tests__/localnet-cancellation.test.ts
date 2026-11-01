// localnet honours its call's cancellation (2F, S7). Regression: it ran Docker
// with execSync, so a `localnet up` froze the MCP server, and a cancelled call
// ran to the end. Docker now runs through a runner the call passes its signal
// to, which kills the Docker client on cancel. No real Docker runs here: the
// command and the start are given a stand-in runner, which answers as Docker
// would, keeps each run's signal, and stops a run (its "kill") when the run's
// signal aborts, as lib/exec-program.ts's runner does (exec-program.test.ts
// shows that one kills a real process).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalnet } from '../commands/localnet.ts';
import { startLocalnet, type DockerCall } from '../lib/localnet.ts';
import { CancelledError } from '../lib/errors.ts';
import type { ExecRun, ExecRunner } from '../lib/exec-program.ts';
import { captureCommand } from '../lib/run-command.ts';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';

/** One run the stand-in was given. */
interface Run {
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  killed: boolean;
}

/** What the stand-in answers a run with: Docker's stdout, or 'hang' (it runs until killed). */
type Answer = string | 'hang';

/** A runner that answers as Docker would and runs nothing; `onRun` sees each run as it starts. */
function standInDocker(answer: (args: readonly string[]) => Answer, onRun: (run: Run) => void = () => {}): { exec: ExecRunner; runs: Run[] } {
  const runs: Run[] = [];
  const exec: ExecRunner = (file, args, { signal }: ExecRun) => {
    expect(file).toBe('docker');
    const run: Run = { args, signal, killed: false };
    runs.push(run);
    onRun(run);
    const reply = answer(args);
    return new Promise<string>((resolve, reject) => {
      const kill = (): void => { run.killed = true; reject(new CancelledError()); };
      if (signal.aborted) { kill(); return; }
      signal.addEventListener('abort', kill, { once: true });
      if (reply !== 'hang') {
        signal.removeEventListener('abort', kill);
        resolve(reply);
      }
    });
  };
  return { exec, runs };
}

const isCompose = (args: readonly string[], ...sub: string[]): boolean =>
  args[0] === 'compose' && args[1] === '-f' && sub.every((word, at) => args[3 + at] === word);

/** `docker compose ps --format json` listing these services, one JSON object a line. */
const psLines = (...services: Array<[string, string]>): string =>
  services.map(([Service, State]) => JSON.stringify({ Service, State, Health: '', Image: `midnightntwrk/${Service}` })).join('\n') + '\n';

let home: string;
let io: CapturedOutput;
const originalHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mn-localnet-cancel-'));
  process.env.HOME = home;
  io = captureOutput();
});

afterEach(() => {
  io.restore();
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

/** Runs `mn localnet <subcommand> --json` as the MCP server does, with the stand-in runner and the call's signal. */
function localnet(subcommand: string, exec: ExecRunner, signal: AbortSignal): Promise<Record<string, unknown>> {
  return captureCommand((args, ctx) => runLocalnet(args, ctx, exec), parseArgs(['localnet', subcommand, '--json']), { signal });
}

describe('localnet commands, cancelled while Docker runs', () => {
  it('status: the Docker client gets the call\'s signal and is killed; the call answers CANCELLED with no result', async () => {
    const call = new AbortController();
    const docker = standInDocker(
      (args) => (isCompose(args, 'ps') ? 'hang' : 'Docker Compose version v2.30.0'),
      (run) => { if (isCompose(run.args, 'ps')) setImmediate(() => call.abort()); },
    );

    const err = await localnet('status', docker.exec, call.signal).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'CANCELLED' });
    const ps = docker.runs.find((run) => isCompose(run.args, 'ps'))!;
    expect(ps.signal).toBe(call.signal);
    expect(ps.killed).toBe(true);
  });

  it('stop: killed mid-run, it answers CANCELLED and does not report the network stopped', async () => {
    const call = new AbortController();
    const docker = standInDocker(
      (args) => (isCompose(args, 'stop') ? 'hang' : 'Docker Compose version v2.30.0'),
      (run) => { if (isCompose(run.args, 'stop')) setImmediate(() => call.abort()); },
    );

    await expect(localnet('stop', docker.exec, call.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(docker.runs.find((run) => isCompose(run.args, 'stop'))!.killed).toBe(true);
  });

  it('clean: cancelled during its compose down, it stops there and removes no container', async () => {
    // Before 2F's S7 the clean swallowed any failure of its compose down, a cancellation included, and went on removing.
    const call = new AbortController();
    const docker = standInDocker(
      (args) => {
        if (isCompose(args, 'down')) return 'hang';
        if (args[0] === 'ps') return 'node|localnet\n';
        return 'Docker Compose version v2.30.0';
      },
      (run) => { if (isCompose(run.args, 'down')) setImmediate(() => call.abort()); },
    );

    await expect(localnet('clean', docker.exec, call.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(docker.runs.find((run) => isCompose(run.args, 'down'))!.killed).toBe(true);
    expect(docker.runs.filter((run) => run.args[0] === 'ps' || run.args[0] === 'rm')).toEqual([]);
  });

  it('a call cancelled before it starts runs no Docker at all', async () => {
    const call = new AbortController();
    call.abort();
    const docker = standInDocker(() => '');
    await expect(localnet('status', docker.exec, call.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(docker.runs).toEqual([]);
  });
});

describe('localnet up, cancelled (decision 4: started containers stay, and it says which)', () => {
  const dockerCall = (exec: ExecRunner, signal: AbortSignal): DockerCall => ({ signal, exec, onStderr: () => {} });

  it('during docker compose up: the client is killed, and the error names the containers left in place', async () => {
    const call = new AbortController();
    const docker = standInDocker(
      (args) => (isCompose(args, 'up') ? 'hang' : psLines(['node', 'running'], ['indexer', 'created'])),
      (run) => { if (isCompose(run.args, 'up')) setImmediate(() => call.abort()); },
    );

    const err = await startLocalnet(dockerCall(docker.exec, call.signal), () => {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CancelledError);
    expect((err as CancelledError).code).toBe('CANCELLED');
    expect((err as Error).message).toContain('the containers it started stay in place: node (running), indexer (created).');
    expect((err as Error).message).toContain('midnight localnet down');
    const up = docker.runs.find((run) => isCompose(run.args, 'up', '-d'))!;
    expect(up.signal).toBe(call.signal);
    expect(up.killed).toBe(true);
    // The containers are listed after the cancellation, by a run of its own that is not cancelled with the call.
    const listing = docker.runs.at(-1)!;
    expect(isCompose(listing.args, 'ps')).toBe(true);
    expect(listing.signal.aborted).toBe(false);
    // Nothing removed or stopped them.
    expect(docker.runs.filter((run) => isCompose(run.args, 'down') || isCompose(run.args, 'stop') || run.args[0] === 'rm')).toEqual([]);
  });

  it('while waiting for the services to be healthy: the wait stops at once, and the error names what is running', async () => {
    const call = new AbortController();
    let polls = 0;
    const docker = standInDocker(
      (args) => (isCompose(args, 'up') ? '' : psLines(['node', 'running'], ['indexer', 'running'], ['proof-server', 'starting'])),
      // The first health poll answers, then the call is cancelled during the wait before the next.
      (run) => { if (isCompose(run.args, 'ps') && ++polls === 1) setImmediate(() => call.abort()); },
    );
    const started = Date.now();

    const err = await startLocalnet(dockerCall(docker.exec, call.signal), () => {}).catch((e: unknown) => e);

    expect((err as CancelledError).code).toBe('CANCELLED');
    expect((err as Error).message).toContain('node (running), indexer (running), proof-server (starting)');
    // It did not sit out the 3s between polls.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(polls).toBe(2); // the health poll, then the listing after the cancellation
  });

  it('cancelled before Docker started any container, it says so', async () => {
    const call = new AbortController();
    const docker = standInDocker(
      (args) => (isCompose(args, 'up') ? 'hang' : ''),
      (run) => { if (isCompose(run.args, 'up')) setImmediate(() => call.abort()); },
    );
    await expect(startLocalnet(dockerCall(docker.exec, call.signal), () => {})).rejects.toThrow('localnet up was stopped before it started any container.');
  });
});
