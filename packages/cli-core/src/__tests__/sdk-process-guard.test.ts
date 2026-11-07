// The guard against the wallet SDK's transient rejections, core's host-called
// process code, in a child process of its own: a transient Wallet.* rejection
// reaches the call listening for it and the run goes on; any other rejection
// still exits 1. Here as mn's shell installs it (lib/cli-host.ts); its
// defaults, as a program meets them, are process-guard-program.test.ts's.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
/** Core's "./process" entry point, by its source. */
const GUARD = resolve(import.meta.dirname, '..', 'process.ts');
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-process-guard-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the guard as mn's shell installs it (console filters on, a rejection outside any call exits)", () => {
  const run = (body: string) => {
    const script = join(dir, 'noise.mjs');
    writeFileSync(script, [
      `const { installSdkProcessGuard } = await import(${JSON.stringify(GUARD)});`,
      `const { WebSocket, WebSocketServer } = await import(${JSON.stringify(join(ROOT, 'node_modules/ws/wrapper.mjs'))});`,
      "const { calls } = installSdkProcessGuard({ console: true, outsideCalls: 'exit' });",
      // A call that starts listening and stays open, as a library inside it does. What
      // the script raises at its top level comes from outside any call: it carries no identity.
      'const listen = (listener) => calls.run(async (warnings) => warnings.listen(listener));',
      body,
    ].join('\n'));
    return spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  };

  it('hands a transient Wallet.* rejection to the listening library and goes on', () => {
    const result = run([
      "await listen((tag, message) => console.log('warned', tag, message));",
      "Promise.reject(Object.assign(new Error('Internal Server Error'), { _tag: 'Wallet.Sync' }));",
      "console.warn('RPC-CORE: submitAndWatchExtrinsic: Custom error: 138');",
      "setTimeout(() => console.log('still running'), 50);",
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('warned Wallet.Sync Internal Server Error\nstill running\n');
    expect(result.stderr).not.toContain('RPC-CORE');
  });

  it("hands the SDK's Wallet.* console.error traces, object or string, to the listener, and prints anything else", () => {
    const result = run([
      "await listen((tag, message) => console.log('warned', tag, message));",
      "console.error({ _tag: 'Wallet.Sync', message: 'Internal Server Error' });",
      "console.error('Wallet.Sync: Internal Server Error\\n    at somewhere');",
      "console.error('a real problem');",
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('warned Wallet.Sync Internal Server Error\nwarned Wallet.Sync transient error\n');
    expect(result.stderr).toBe('a real problem\n');
  });

  it("drops polkadot-js's own logger lines about its API and connection while a call listens, and keeps a real error", () => {
    const result = run([
      `const { logger } = await import(${JSON.stringify(join(ROOT, 'node_modules/@polkadot/util/logger.js'))});`,
      "await listen(undefined);",
      "logger('API-WS').error('disconnected from ws://127.0.0.1:1/: 1006:: Abnormal Closure');",
      "logger('API/INIT').error('Error: FATAL: Unable to initialize the API: connect ECONNREFUSED');",
      "logger('API-WS').warn('reconnecting');",
      "logger('API-WS').log('connected');",
      "console.error('a real problem');",
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('a real problem\n');
    expect(result.stdout).toBe('');
  });

  it('touches nothing while no call listens: SDK traces and RPC noise print as they would without the guard', () => {
    const result = run([
      "console.error({ _tag: 'Wallet.Sync', message: 'Internal Server Error' });",
      "console.warn('RPC-CORE: submitAndWatchExtrinsic: Custom error: 138');",
      "const stop = await listen(undefined);",
      "console.warn('RPC-CORE: kept off while listening');",
      "stop();",
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Wallet.Sync');
    expect(result.stderr).toContain('RPC-CORE: submitAndWatchExtrinsic');
    expect(result.stderr).not.toContain('kept off while listening');
  });

  it('exits 1 on a Wallet.* rejection while no call listens, as Node does without the guard', () => {
    const result = run("Promise.reject(Object.assign(new Error('Internal Server Error'), { _tag: 'Wallet.Sync' }));\nsetTimeout(() => console.log('still running'), 500);");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('still exits 1 on a rejection that is only a string, even one starting Wallet.', () => {
    const result = run("await listen(() => console.log('warned'));\nPromise.reject('Wallet.Sync: not an SDK error object');\nsetTimeout(() => console.log('still running'), 500);");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('still exits 1 on any other unhandled rejection', () => {
    const result = run("Promise.reject(new Error('a real failure'));\nsetTimeout(() => console.log('still running'), 500);");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a real failure');
    expect(result.stdout).not.toContain('still running');
  });
});

// Each call's SDK warnings are its own. Regression: one listener
// stack for the process, whose newest listener got every warning, so two
// calls at once in the MCP server got each other's.
describe('the guard gives each call its own SDK warnings', () => {
  const run = (body: string) => {
    const script = join(dir, 'calls.mjs');
    writeFileSync(script, [
      `const { installSdkProcessGuard } = await import(${JSON.stringify(GUARD)});`,
      `const { WebSocket, WebSocketServer } = await import(${JSON.stringify(join(ROOT, 'node_modules/ws/wrapper.mjs'))});`,
      "const { calls } = installSdkProcessGuard({ console: true, outsideCalls: 'exit' });",
      'const listen = (listener) => calls.run(async (warnings) => warnings.listen(listener));',
      "const sdkError = (message, tag = 'Wallet.Sync') => Object.assign(new Error(message), { _tag: tag });",
      'const said = [];',
      body,
    ].join('\n'));
    return spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  };

  it('two calls at once: what each raises from its timers and its WebSocket callbacks reaches it alone, and none reaches the terminal', () => {
    const result = run([
      // A server outside both calls: it answers each socket from its own callbacks, a little later.
      'const server = new WebSocketServer({ port: 0 });',
      "await new Promise((resolve) => server.once('listening', resolve));",
      "server.on('connection', (socket) => socket.on('message', (m) => setTimeout(() => socket.send(String(m)), 5)));",
      'const call = (name) => calls.run(async (warnings) => {',
      '  const stop = warnings.listen((tag, message) => said.push(`${name} got ${tag} ${message}`));',
      '  await new Promise((done) => {',
      '    setTimeout(() => Promise.reject(sdkError(`${name}: timer rejection`)), 10);',
      "    setTimeout(() => console.error({ _tag: 'Wallet.Sync', message: `${name}: timer trace` }), 15);",
      "    setInterval(function tick() { console.error({ _tag: 'Wallet.Sync', message: `${name}: interval trace` }); clearInterval(this); }, 20);",
      '    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);',
      "    socket.on('open', () => socket.send(name));",
      "    socket.on('message', () => {",
      "      console.error({ _tag: 'Wallet.Sync', message: `${name}: socket trace` });",
      "      Promise.reject(sdkError(`${name}: socket rejection`, 'Wallet.Indexer'));",
      "      console.warn('RPC-CORE: submitAndWatchExtrinsic: Custom error: 138');",
      '      socket.close();',
      '      setTimeout(done, 40);',
      '    });',
      '  });',
      '  stop();',
      '});',
      "await Promise.all([call('a'), call('b')]);",
      'server.close();',
      "console.log(said.sort().join('\\n'));",
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'a got Wallet.Indexer a: socket rejection',
      'a got Wallet.Sync a: interval trace',
      'a got Wallet.Sync a: socket trace',
      'a got Wallet.Sync a: timer rejection',
      'a got Wallet.Sync a: timer trace',
      'b got Wallet.Indexer b: socket rejection',
      'b got Wallet.Sync b: interval trace',
      'b got Wallet.Sync b: socket trace',
      'b got Wallet.Sync b: timer rejection',
      'b got Wallet.Sync b: timer trace',
    ]);
    expect(result.stderr).toBe('');
  });

  it("goes to the newest listener of the call that raised it, and to no other call's", () => {
    const result = run([
      "await listen((tag, message) => said.push(`other call: ${message}`));",
      'await calls.run(async (warnings) => {',
      "  warnings.listen((tag, message) => said.push(`outer: ${message}`));",
      "  const stopInner = warnings.listen((tag, message) => said.push(`inner: ${message}`));",
      "  console.error({ _tag: 'Wallet.Sync', message: 'first' });",
      '  stopInner();',
      "  console.error({ _tag: 'Wallet.Sync', message: 'second' });",
      '});',
      'console.log(JSON.stringify(said));',
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['inner: first', 'outer: second']);
  });

  it("a call's warning after it stopped listening goes to no other call, and stays off the terminal while one listens", () => {
    const result = run([
      "await listen((tag, message) => said.push(`other call: ${message}`));",
      'await calls.run(async (warnings) => {',
      '  warnings.listen(undefined)();',
      "  console.error({ _tag: 'Wallet.Sync', message: 'after it stopped' });",
      "  await new Promise((resolve) => { Promise.reject(sdkError('rejected after it stopped')); setTimeout(resolve, 20); });",
      '});',
      'console.log(JSON.stringify(said));',
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr).toBe('');
  });

  it('a warning from outside any call goes to the one call listening', () => {
    const result = run([
      "await listen((tag, message) => said.push(`the call: ${message}`));",
      "console.error({ _tag: 'Wallet.Sync', message: 'from nowhere' });",
      "Promise.reject(sdkError('rejected from nowhere'));",
      'setTimeout(() => console.log(JSON.stringify(said)), 50);',
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['the call: from nowhere', 'the call: rejected from nowhere']);
  });

  it('a warning from outside any call while several listen goes to none of them, and stays off the terminal', () => {
    const result = run([
      "await listen((tag, message) => said.push(`a: ${message}`));",
      "await listen((tag, message) => said.push(`b: ${message}`));",
      "console.error({ _tag: 'Wallet.Sync', message: 'from nowhere' });",
      "Promise.reject(sdkError('rejected from nowhere'));",
      "console.warn('RPC-CORE: submitAndWatchExtrinsic: Custom error: 138');",
      'setTimeout(() => console.log(JSON.stringify(said)), 50);',
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr).toBe('');
  });
});
