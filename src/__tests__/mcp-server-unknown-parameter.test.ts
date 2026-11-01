// A tool parameter the tool doesn't take is refused (Y29, plan 2C): one that
// is neither a schema property nor, for a tool that passes its other
// parameters on as flags, a flag its command accepts. The server used to turn
// every parameter into a flag unchecked, so a misspelt one was silently
// dropped and the command ran on its defaults (the CLI has refused unknown flags since the wrong-chain write).
// Run through this checkout's MCP server as a real process with a temporary
// home: nothing reaches a chain.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

let home: string;
let client: Client;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-mcp-unknown-param-home-')));
  const env = { ...process.env, HOME: home, NO_COLOR: '1' } as Record<string, string>;
  client = new Client({ name: 'mn-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: TSX, args: [path.join(REPO, 'src', 'mcp-server.ts')], env, stderr: 'ignore' }));
}, 60_000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown> };
};

describe('a tool parameter outside the tool\'s schema', () => {
  it('is refused as INVALID_ARGS, naming it and the parameters the tool takes, and the tool does not run', async () => {
    const { isError, body } = await call('midnight_config_get', { key: 'network', 'zz-not-a-flag': '1' });
    expect(isError).toBe(true);
    expect(body).toStrictEqual({
      error: true,
      code: 'INVALID_ARGS',
      message: 'Unknown parameter for midnight_config_get: zz-not-a-flag\nIts parameters: key, network',
      _serverVersion: expect.any(String),
    });
  }, 60_000);

  it('names every unknown parameter', async () => {
    const { body } = await call('midnight_config_get', { key: 'network', netwrok: 'preprod', node: 'ws://x' });
    expect(body).toMatchObject({ error: true, code: 'INVALID_ARGS' });
    expect(body.message).toBe('Unknown parameters for midnight_config_get: netwrok, node\nIts parameters: key, network');
  }, 60_000);

  it('is refused before a tool behind confirmation gives a token', async () => {
    const { isError, body } = await call('midnight_transfer', { to: 'mn_addr_undeployed1x', amount: '1', network: 'undeployed', nodes: 'ws://x' });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: true, code: 'INVALID_ARGS' });
    // network is not in the schema, but transfer accepts --network and the tool passes it on.
    expect(body.message).toBe(
      'Unknown parameter for midnight_transfer: nodes\n' +
      'Its parameters: to, amount, wallet, and its command\'s flags: force-shielded, network, no-cache, shielded, verbose, wallet, node, indexer-ws, proof-server, help, h, json, version, v',
    );
    expect(body.token).toBeUndefined();
    expect(body.pending).toBeUndefined();
  }, 60_000);

  it('lets a flag the command accepts through on a tool that passes parameters on as flags', async () => {
    // genesis-address's schema has only network; --json is a flag every command takes.
    const { isError, body } = await call('midnight_genesis_address', { network: 'undeployed', json: true });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ network: 'undeployed' });
  }, 60_000);

  it('is refused on the confirm tool too', async () => {
    const { body } = await call('midnight_confirm_operation', { token: 'nope', extra: true });
    expect(body).toMatchObject({ error: true, code: 'INVALID_ARGS', message: 'Unknown parameter for midnight_confirm_operation: extra\nIts parameters: token' });
  }, 60_000);

  it('leaves a call with only the schema\'s parameters to run as before', async () => {
    const { isError, body } = await call('midnight_config_get', { key: 'network' });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ action: 'get', key: 'network' });
  }, 60_000);
});
