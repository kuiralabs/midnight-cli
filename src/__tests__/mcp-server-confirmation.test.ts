// A tool that moves funds answers its first call with a confirmation token and
// does nothing else. Run through this checkout's MCP server as a real process,
// with a temporary home and an account on record as an earlier mn left it:
// nothing reaches a chain.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expectDeclaredToolResult } from './helpers/expect-declared.ts';
import { freshGrantee, grantRequestFor, grantRequestLink } from '@kuiralabs/midnight-account-chain/agent';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const ENDPOINTS = { node: 'ws://localhost:29944', 'indexer-ws': 'ws://localhost:28088/api/v4/graphql/ws', 'proof-server': 'http://localhost:26300' };
// How a confirmation names those endpoints.
const VIA = '. Endpoints: node ws://localhost:29944, indexer ws://localhost:28088/api/v4/graphql/ws, proof server http://localhost:26300';

// An account's records as mn 0.6.0-rc.10 left them.
const ACCOUNT = '5e'.repeat(32);
const OWNER_RECORD = { contractAddress: ACCOUNT, deviceArm: 'k1', deviceSk: '4f'.repeat(32), bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) };

let home: string;
let recordsDir: string;
let dappDir: string;
let client: Client;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-mcp-confirm-home-')));
  const env = { ...process.env, HOME: home, NO_COLOR: '1', MN_PASSPHRASE: 'correct horse battery staple' } as Record<string, string>;
  execFileSync(TSX, [path.join(REPO, 'src', 'wallet.ts'), 'wallet', 'generate', 'alice', '--json'], { env, stdio: 'ignore' });
  execFileSync(TSX, [path.join(REPO, 'src', 'wallet.ts'), 'wallet', 'generate', 'bob', '--json'], { env, stdio: 'ignore' });
  execFileSync(TSX, [path.join(REPO, 'src', 'wallet.ts'), 'wallet', 'generate', 'carol', '--json'], { env, stdio: 'ignore' });
  execFileSync(TSX, [path.join(REPO, 'src', 'wallet.ts'), 'wallet', 'use', 'alice'], { env, stdio: 'ignore' });
  // An account on record for alice.
  recordsDir = path.join(home, '.midnight', 'accounts', 'undeployed', 'alice');
  fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(recordsDir, 'owner.json'), JSON.stringify(OWNER_RECORD), { mode: 0o600 });
  // A compiled contract, as compactc leaves it.
  dappDir = path.join(home, 'dapp');
  const compiler = path.join(dappDir, 'managed', 'counter', 'compiler');
  fs.mkdirSync(compiler, { recursive: true });
  fs.writeFileSync(path.join(compiler, 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.35.0', 'language-version': '0.27.0', 'runtime-version': '0.20.0',
    circuits: [{ name: 'increment', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } }],
    witnesses: [],
  }));

  client = new Client({ name: 'mn-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: TSX, args: [path.join(REPO, 'src', 'mcp-server.ts')], env, stderr: 'ignore' }));
}, 60_000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** The tool each pending token was issued for: confirming it runs that tool's command. */
const pendingTools = new Map<unknown, string>();

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
  if (body.pending === true) pendingTools.set(body.token, name);
  const ran = name === 'midnight_confirm_operation' ? pendingTools.get(args.token) : name;
  if (ran !== undefined) expectDeclaredToolResult(ran, body);
  return body;
};

/** Every file under the home, with its contents: what a call that does nothing leaves as it was. */
function homeState(): Record<string, string> {
  const state: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else state[path.relative(home, full)] = fs.readFileSync(full, 'base64');
    }
  };
  walk(home);
  return state;
}

const ARTEFACT_CACHE_COMPILER_FILE = /^\.midnight\/account-artifacts\/[0-9a-f]{16}\/compiler\/[^/]+$/;
const withoutArtefactCache = (state: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(state).filter(([file]) => !ARTEFACT_CACHE_COMPILER_FILE.test(file)));

describe('every tool that acts answers with a token, and does nothing until it is confirmed', () => {
  const ADDRESS = 'ab'.repeat(32);
  // A grant request as an agent sends it, for alice's account.
  const link = (): string => grantRequestLink(grantRequestFor(
    { account: ACCOUNT, clientId: 'rdns:org.example.agent', grantee: freshGrantee('k1'), readSecret: new Uint8Array(32).fill(7) },
    3, new Uint8Array(32).fill(0x9a), 2,
  ));
  const cases: Array<[string, () => Record<string, unknown>, () => string | RegExp]> = [
    ['midnight_transfer', () => ({ to: 'carol', amount: '5', wallet: 'alice', network: 'undeployed', ...ENDPOINTS }), () => 'Send 5 NIGHT from alice to carol on undeployed' + VIA],
    ['midnight_contract_deploy', () => ({ path: dappDir, wallet: 'alice', network: 'undeployed', ...ENDPOINTS }), () => `Deploy contract from ${dappDir} as alice on undeployed` + VIA],
    ['midnight_contract_call', () => ({ path: dappDir, address: ADDRESS, circuit: 'increment', wallet: 'alice', network: 'undeployed', ...ENDPOINTS }), () => `Call circuit increment on contract ${ADDRESS} as alice on undeployed` + VIA],
    ['midnight_grant_deploy', () => ({ wallet: 'carol', network: 'undeployed', ...ENDPOINTS }), () => "Deploy an account for carol on undeployed; its owner key is made on this machine and kept encrypted under mn's passphrase" + VIA],
    ['midnight_grant_deposit', () => ({ amount: '2', wallet: 'alice', network: 'undeployed', ...ENDPOINTS }), () => `Deposit 2 shielded NIGHT (2000000 in the smallest unit) from wallet alice into its account ${ACCOUNT} on undeployed` + VIA],
    ['midnight_grant_issue', () => ({ link: link(), wallet: 'alice', network: 'undeployed', ...ENDPOINTS }), () => new RegExp(`^Issue a grant on alice's account on undeployed, letting an agent spend from it within these terms .*${ACCOUNT}[\\s\\S]*\\. Endpoints: node ws://localhost:29944, indexer ws://localhost:28088/api/v4/graphql/ws, proof server http://localhost:26300$`)],
    ['midnight_grant_revoke', () => ({ grant: '3', wallet: 'alice', network: 'undeployed', ...ENDPOINTS }), () => "Revoke grant 3 on alice's account on undeployed" + VIA],
    ['midnight_grant_revoke_all', () => ({ wallet: 'alice', network: 'undeployed', ...ENDPOINTS }), () => "Revoke every grant on alice's account on undeployed" + VIA],
    ['midnight_wallet_remove', () => ({ name: 'carol' }), () => 'Remove wallet carol: its file, and the seed in it, is deleted from this machine'],
  ];

  it.each(cases)('%s', async (tool, params, description) => {
    const before = withoutArtefactCache(homeState());
    const pending = await call(tool, params());

    expect(pending.error, String(pending.message)).toBeUndefined();
    expect(pending.pending).toBe(true);
    expect(pending.tool).toBe(tool);
    expect(pending.token).toEqual(expect.any(String));
    const expected = description();
    if (typeof expected === 'string') expect(pending.description).toBe(expected);
    else expect(pending.description).toMatch(expected);
    // The one thing a check may leave: the account's artefact cache, set up when an
    // issue's preview opens the account, holding a copy of the installed contract's
    // compiler files (no network, no keys).
    const after = withoutArtefactCache(homeState());
    expect(Object.keys(after).filter((file) => !(file in before)), 'files the call wrote').toEqual([]);
    expect(after).toStrictEqual(before);
  }, 60_000);
});

describe('midnight_grant_deposit', () => {
  it('answers with a token whose description names the amount in both units and the account, and deposits nothing', async () => {
    const pending = await call('midnight_grant_deposit', { amount: '1.5', wallet: 'alice', network: 'undeployed', ...ENDPOINTS });

    expect(pending.pending).toBe(true);
    expect(pending.token).toEqual(expect.any(String));
    expect(pending.tool).toBe('midnight_grant_deposit');
    expect(pending.description).toBe(`Deposit 1.5 shielded NIGHT (1500000 in the smallest unit) from wallet alice into its account ${ACCOUNT} on undeployed${VIA}`);
    // Nothing was built or kept: the records are as they were, and no private state was opened.
    expect(fs.readdirSync(recordsDir)).toEqual(['owner.json']);
    expect(JSON.parse(fs.readFileSync(path.join(recordsDir, 'owner.json'), 'utf8'))).toEqual(OWNER_RECORD);
  }, 60_000);

  it('names the token, by its raw type, and the amount in its smallest unit when one is given', async () => {
    const token = '02005c8a9e3d6e3a2b0e1c4f7d9a8b6c5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';
    const pending = await call('midnight_grant_deposit', { amount: '9007199254740993', token, wallet: 'alice', network: 'undeployed', ...ENDPOINTS });

    expect(pending.error, String(pending.message)).toBeUndefined();
    expect(pending.description).toBe(`Deposit 9007199254740993 of shielded token ${token} (in its smallest unit) from wallet alice into its account ${ACCOUNT} on undeployed${VIA}`);
    expect(fs.readdirSync(recordsDir)).toEqual(['owner.json']);
  }, 60_000);

  it('refuses a token that is not a raw token type before any token is given', async () => {
    const refused = await call('midnight_grant_deposit', { amount: '5', token: 'night', wallet: 'alice', network: 'undeployed', ...ENDPOINTS });
    expect(refused).toMatchObject({ error: true, code: 'INVALID_ARGS' });
    expect(refused.token).toBeUndefined();
  }, 60_000);

  it('refuses a deposit that can\'t run before any token is given', async () => {
    const refused = await call('midnight_grant_deposit', { amount: '1.0000001', wallet: 'alice', network: 'undeployed', ...ENDPOINTS });
    expect(refused).toMatchObject({ error: true, code: 'INVALID_ARGS' });
    expect(refused.token).toBeUndefined();
  }, 60_000);
});

describe('endpoints in what the user confirms', () => {
  it('names one set with config for the network, and leaves out what is the network\'s own', async () => {
    const file = path.join(home, '.midnight', 'config.json');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    fs.writeFileSync(file, JSON.stringify({ ...(before === undefined ? {} : JSON.parse(before)), networks: { undeployed: { 'proof-server': 'http://proofs.example:6300' } } }));
    try {
      const pending = await call('midnight_transfer', { to: 'carol', amount: '5', wallet: 'alice', network: 'undeployed', node: ENDPOINTS.node, 'indexer-ws': ENDPOINTS['indexer-ws'] });
      expect(pending.error, String(pending.message)).toBeUndefined();
      expect(pending.description).toBe('Send 5 NIGHT from alice to carol on undeployed. Endpoints: node ws://localhost:29944, indexer ws://localhost:28088/api/v4/graphql/ws, proof server http://proofs.example:6300 (set with config)');
    } finally {
      if (before === undefined) fs.rmSync(file);
      else fs.writeFileSync(file, before);
    }
  });

  it('names none for a tool that takes no endpoints', async () => {
    const pending = await call('midnight_wallet_remove', { name: 'carol' });
    expect(pending.description).toBe('Remove wallet carol: its file, and the seed in it, is deleted from this machine');
  });
});

describe('midnight_wallet_generate with force', () => {
  const walletFile = (name: string) => path.join(home, '.midnight', 'wallets', `${name}.json`);

  it('answers with a token naming what is deleted, and replaces nothing', async () => {
    const before = fs.readFileSync(walletFile('carol'), 'utf8');
    const pending = await call('midnight_wallet_generate', { name: 'carol', force: true });

    expect(pending.pending).toBe(true);
    expect(pending.tool).toBe('midnight_wallet_generate');
    expect(pending.description).toBe('Replace wallet carol: its file, and the seed in it, is deleted from this machine and a new wallet written in its place');
    expect(fs.readFileSync(walletFile('carol'), 'utf8')).toBe(before);
  });

  it('says nothing is replaced when no wallet has the name', async () => {
    const pending = await call('midnight_wallet_generate', { name: 'dave', force: true });

    expect(pending.description).toBe('Create wallet dave (no wallet of that name exists, so nothing is replaced)');
    expect(fs.existsSync(walletFile('dave'))).toBe(false);
  });

  it('replaces the wallet once the token is confirmed', async () => {
    const before = JSON.parse(fs.readFileSync(walletFile('carol'), 'utf8')) as { addresses: Record<string, string> };
    const pending = await call('midnight_wallet_generate', { name: 'carol', force: true });
    const done = await call('midnight_confirm_operation', { token: pending.token });

    expect(done.error, String(done.message)).toBeUndefined();
    const after = JSON.parse(fs.readFileSync(walletFile('carol'), 'utf8')) as { addresses: Record<string, string> };
    expect(after.addresses.undeployed).not.toBe(before.addresses.undeployed);
    // Generating makes the new wallet active; alice stays the active one for the tests after.
    await call('midnight_wallet_use', { name: 'alice' });
  }, 60_000);

  it('runs at once without force, and refuses a wallet that exists', async () => {
    const refused = await call('midnight_wallet_generate', { name: 'bob' });

    expect(refused.pending).toBeUndefined();
    expect(String(refused.message)).toContain('Wallet "bob" already exists');
  });
});

describe('midnight_wallet_remove', () => {
  const walletFile = (name: string) => path.join(home, '.midnight', 'wallets', `${name}.json`);

  it('answers with a token naming what is deleted, and removes nothing', async () => {
    const pending = await call('midnight_wallet_remove', { name: 'bob' });

    expect(pending.pending).toBe(true);
    expect(pending.tool).toBe('midnight_wallet_remove');
    expect(pending.description).toBe('Remove wallet bob: its file, and the seed in it, is deleted from this machine');
    expect(fs.existsSync(walletFile('bob'))).toBe(true);
  });

  it('refuses the active wallet before any token is given', async () => {
    const refused = await call('midnight_wallet_remove', { name: 'alice' });

    expect(refused.pending).toBeUndefined();
    expect(String(refused.message)).toContain('Cannot remove the active wallet "alice"');
    expect(fs.existsSync(walletFile('alice'))).toBe(true);
  });

  it('removes the wallet once the token is confirmed', async () => {
    const pending = await call('midnight_wallet_remove', { name: 'bob' });
    const done = await call('midnight_confirm_operation', { token: pending.token });

    expect(done).toMatchObject({ wallet: 'bob', removed: true });
    expect(fs.existsSync(walletFile('bob'))).toBe(false);
  });
});
