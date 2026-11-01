// A tool parameter the tool doesn't take is refused (Y29): since 2E, one
// outside the tool's schema, which lists every parameter the tool takes (2C
// also let through any flag of the tool's command). The server used to turn
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

// A port nothing listens on: an endpoint a call is given never reaches a chain.
const CLOSED = { node: 'ws://127.0.0.1:1', 'indexer-ws': 'ws://127.0.0.1:1/api/v4/graphql/ws', 'proof-server': 'http://127.0.0.1:1' };

describe('a tool\'s schema, generated from its command\'s flags (plan 2E)', () => {
  it('shows midnight_transfer\'s network and endpoints, which agents could pass but not see', async () => {
    const { tools } = await client.listTools();
    const transfer = tools.find((tool) => tool.name === 'midnight_transfer')!;
    expect(Object.keys(transfer.inputSchema.properties ?? {})).toStrictEqual([
      'to', 'amount', 'wallet', 'force-shielded', 'network', 'shielded', 'node', 'indexer-ws', 'proof-server',
    ]);
    expect(transfer.inputSchema.properties!.network).toStrictEqual({
      type: 'string', enum: ['preprod', 'preview', 'undeployed'], description: 'Network to send on (default: the selected one)',
    });
    expect(transfer.inputSchema.required).toStrictEqual(['to', 'amount']);
  }, 60_000);

  it('is the one check: a flag of the command outside it is refused, though 2C let it through', async () => {
    // --json is a flag every command takes, and the server always sets it.
    const { isError, body } = await call('midnight_genesis_address', { network: 'undeployed', json: true });
    expect(isError).toBe(true);
    expect(body).toStrictEqual({
      error: true,
      code: 'INVALID_ARGS',
      message: 'Unknown parameter for midnight_genesis_address: json\nIts parameters: network',
      _serverVersion: expect.any(String),
    });
  }, 60_000);

  it('refuses yes on midnight_grant_request, which would issue the grant with no confirmation', async () => {
    const { isError, body } = await call('midnight_grant_request', { link: 'not-a-link', yes: true, network: 'undeployed', ...CLOSED });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: true, code: 'INVALID_ARGS' });
    expect(body.message).toBe(
      'Unknown parameter for midnight_grant_request: yes\n' +
      'Its parameters: link, cap, per-call, max-coin, expires-in, wallet, network, node, indexer-ws, proof-server',
    );
  }, 60_000);
});

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
    // network is in the schema since 2E: transfer accepts --network and the tool passes it on.
    expect(body.message).toBe(
      'Unknown parameter for midnight_transfer: nodes\n' +
      'Its parameters: to, amount, wallet, force-shielded, network, shielded, node, indexer-ws, proof-server',
    );
    expect(body.token).toBeUndefined();
    expect(body.pending).toBeUndefined();
  }, 60_000);

  it('lets through a flag of the command its schema gained in 2E, which reaches the command', async () => {
    // address's schema gained --wallet; with --seed given too, the seed wins, as at the CLI.
    const { tools } = await client.listTools();
    expect(Object.keys(tools.find((t) => t.name === 'midnight_address')!.inputSchema.properties ?? {})).toContain('wallet');
    const derived = await call('midnight_address', { seed: '01'.repeat(32), network: 'undeployed', wallet: 'nobody' });
    expect(derived.isError).toBe(false);
    expect(derived.body).toMatchObject({ network: 'undeployed', index: 0 });
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
