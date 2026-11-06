// A tool call that asks for progress gets what the command's spinners say as
// progress notifications, though the command runs in --json mode. Run through
// this checkout's MCP server as a real process, with a temporary home: the
// indexer is an endpoint the test runs that refuses every connection, so
// nothing reaches a chain. It keeps its port while the tests run: a port
// merely closed could be taken by another test under load.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JSONRPCMessage, Progress } from '@modelcontextprotocol/sdk/types.js';
import { startRefusingEndpoint } from '../../test-support/stand-in-indexer.ts';
import { expectDeclaredToolResult } from './helpers/expect-declared.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

let home: string;
let client: Client;
/** Every JSON-RPC message the server sent, and every one the client sent, in order. */
const fromServer: JSONRPCMessage[] = [];
const fromClient: JSONRPCMessage[] = [];
let refusing: { port: number; close(): Promise<void> };
let aliceAddress: string;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-mcp-progress-home-')));
  const env = { ...process.env, HOME: home, NO_COLOR: '1', MN_PASSPHRASE: 'correct horse battery staple' } as Record<string, string>;
  const generated = execFileSync(TSX, [path.join(REPO, 'src', 'wallet.ts'), 'wallet', 'generate', 'alice', '--network', 'undeployed', '--json'], { env, encoding: 'utf8' });
  aliceAddress = JSON.parse(generated).addresses.undeployed;
  refusing = await startRefusingEndpoint();

  client = new Client({ name: 'mn-test', version: '0' });
  const transport = new StdioClientTransport({ command: TSX, args: [path.join(REPO, 'src', 'mcp-server.ts')], env, stderr: 'ignore' });
  await client.connect(transport);
  // Watch the channel both ways, beneath the client: the client drops a
  // progress notification that arrives in the same read as its call's answer
  // (it handles the answer first), so what the server sent is read here.
  const deliver = transport.onmessage!;
  transport.onmessage = (message) => { fromServer.push(message); deliver(message); };
  const send = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage) => { fromClient.push(message); return send(message); };
}, 60_000);

/** The last tools/call the client sent: its id and progress token, if it asked for progress. */
function lastCall(): { id: unknown; progressToken: unknown } {
  const sent = fromClient.filter((m) => 'method' in m && m.method === 'tools/call').at(-1) as
    { id: unknown; params: { _meta?: { progressToken?: unknown } } } | undefined;
  expect(sent, 'a tools/call').toBeDefined();
  return { id: sent!.id, progressToken: sent!.params._meta?.progressToken };
}

/** Where the server's answer to the request `id` is on the channel. */
const answerAt = (id: unknown): number => fromServer.findIndex((m) => 'id' in m && m.id === id && ('result' in m || 'error' in m));

/** The progress notifications the server sent for `token`, with where each is on the channel. */
function progressOnChannel(token: unknown): Array<Progress & { at: number }> {
  return fromServer.flatMap((m, at) => {
    if (!('method' in m) || m.method !== 'notifications/progress') return [];
    const { progressToken, ...update } = m.params as Progress & { progressToken: unknown };
    return progressToken === token ? [{ ...update, at }] : [];
  });
}

afterAll(async () => {
  await client?.close();
  await refusing?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

// An address's balance: its spinner starts before the indexer is reached.
const balanceOfAlice = () => ({
  name: 'midnight_balance',
  arguments: { address: aliceAddress, 'indexer-ws': `ws://127.0.0.1:${refusing.port}/api/v4/graphql/ws` },
});

describe('progress notifications', () => {
  it('sends what the command says while it runs, in order and numbered, before its result', async () => {
    const result = await client.callTool(balanceOfAlice(), undefined, { onprogress: () => {} });
    const call = lastCall();
    expect(call.progressToken).toBeDefined();
    const progress = progressOnChannel(call.progressToken);

    expect(progress[0]).toMatchObject({ progress: 1, message: 'Checking balance on undeployed...' });
    expect(progress.map((update) => update.progress)).toEqual(progress.map((_, index) => index + 1));
    expect(Math.max(...progress.map((update) => update.at))).toBeLessThan(answerAt(call.id));
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    expect(body).toMatchObject({ error: true, code: 'NETWORK_ERROR' });
    expectDeclaredToolResult('midnight_balance', body);
  }, 60_000);

  it('sends none to a call that asked for none, which gets the same result', async () => {
    const before = fromServer.length;
    const result = await client.callTool(balanceOfAlice());
    expect(lastCall().progressToken).toBeUndefined();
    expect(fromServer.slice(before).filter((m) => 'method' in m && m.method === 'notifications/progress')).toEqual([]);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    expect(body).toMatchObject({ error: true, code: 'NETWORK_ERROR' });
    expectDeclaredToolResult('midnight_balance', body);
  }, 60_000);
});
