// A stopped wallet facade leaves nothing that keeps the process up: a program
// that closed its wallet ends by itself, without process.exit. Each engine
// runs this suite with its own facade module.
//
// The program runs in a child process (what keeps a process up shows only from
// outside it) against stand-ins in this one: a silent indexer, and a node that
// refuses every connection or takes it and never answers. It builds the
// engine's facade, starts its sync (which never completes against silence),
// stops it, and returns.
//
// Regression: the SDK's submission service opened its node client when the
// facade was built, and its close() waited for that client to be ready, so
// against such a node stop never finished, polkadot-js reconnected every 2.5 s
// for good, and the program never ended. And stop's 5 s wait was never
// cleared, which kept even a clean stop's process up 5 s more.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { closedPort } from './closed-port.ts';
import { startSilentNetwork, type SilentNetwork } from './stand-in-indexer.ts';

const ROOT = resolve(import.meta.dirname, '..');
/** How long a stopped program may take to end by itself: well under the 5 s wait stop used to leave behind. */
const ENDS_WITHIN_MS = 2_500;
/** When the child is killed as hung: it never ended by itself. */
const HUNG_AFTER_MS = 30_000;

/** What the child program says as it ends. */
interface Ended {
  /** How its sync ended: the error's name. */
  synced: string;
  /** How long stopFacade took, and how long after stopping began the process ended. */
  stoppedMs: number;
  exitedMs: number;
}

/** The program: build, start and stop the facade of `facadeModule` against the network in NETWORK, then return. */
const program = (facadeModule: string): string => `
import { writeSync } from 'node:fs';
const { buildFacade, startAndSyncFacade, stopFacade } = await import(${JSON.stringify(facadeModule)});
const bundle = await buildFacade(Buffer.alloc(32, 7), JSON.parse(process.env.NETWORK), process.env.STATE_ROOT, () => {});
let synced = 'synced';
try {
  await startAndSyncFacade(bundle, { syncMode: 'full', timeoutMs: 1000 });
} catch (err) {
  synced = err.name;
}
const stopping = Date.now();
await stopFacade(bundle);
const stoppedMs = Date.now() - stopping;
process.on('exit', () => writeSync(1, JSON.stringify({ synced, stoppedMs, exitedMs: Date.now() - stopping }) + '\\n'));
`;

/** Runs the program to its end; killed after HUNG_AFTER_MS when it doesn't end by itself. */
function runProgram(script: string, network: NetworkConfig, stateRoot: string): Promise<{ code: number | null; ended: Ended | undefined; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: ROOT,
      env: { ...process.env, NETWORK: JSON.stringify(network), STATE_ROOT: stateRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const hung = setTimeout(() => child.kill('SIGKILL'), HUNG_AFTER_MS);
    child.on('exit', (code) => {
      clearTimeout(hung);
      const line = stdout.trim().split('\n').at(-1);
      done({ code, ended: line?.startsWith('{') ? JSON.parse(line) as Ended : undefined, stderr });
    });
  });
}

export function facadeStopSuite(engine: { set: string; facadeModule: string }): void {
  describe(`the ${engine.set} engine's facade, stopped, leaves nothing that keeps the process up`, () => {
    let dir: string;
    let silent: SilentNetwork;
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), `mn-facade-stop-${engine.set}-`));
      writeFileSync(join(dir, 'program.mjs'), program(engine.facadeModule));
      silent = await startSilentNetwork();
    });
    afterEach(async () => {
      await silent.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const network = (node: string): NetworkConfig => ({ networkId: 'Undeployed', indexer: silent.indexer, indexerWS: silent.indexerWS, node, proofServer: 'http://127.0.0.1:9' });

    it.each([
      ['refuses every connection', async () => `ws://127.0.0.1:${await closedPort()}`],
      ['takes the connection and never answers', async () => silent.node],
    ])('a program ends by itself when the node %s, with every socket it opened closed', async (_how, node) => {
      const { code, ended, stderr } = await runProgram(join(dir, 'program.mjs'), network(await node()), join(dir, 'state'));
      expect(code, stderr).toBe(0);
      expect(ended).toBeDefined();
      // The sync really ran against the stand-in, and never completed there.
      expect(ended!.synced).toBe('SyncTimeoutError');
      expect(silent.opened.filter((path) => path === '/api/v4/graphql/ws').length).toBeGreaterThan(0);
      expect(ended!.stoppedMs).toBeLessThan(ENDS_WITHIN_MS);
      expect(ended!.exitedMs).toBeLessThan(ENDS_WITHIN_MS);
      // A facade that submitted nothing never connected to the node.
      expect(silent.opened).not.toContain('/node');
      await silent.allClosed();
      expect(silent.open()).toBe(0);
    });
  });
}
