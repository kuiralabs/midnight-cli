// The command registry (plan 2B): every command defined once, beside it.
// Since 2C the CLI's dispatch, its SDK commands and its accepted flags come
// from it, and since 2D help, the manual and the intro; their tests pin what
// the lists they replaced said, and those lists stay until Y13 approves their
// removal. Since 2E the MCP server's tools come from it too: the tests here
// compare what it generates with the list the server kept until then (TOOLS),
// which differs only in the parameters the schemas gain (Y29). Where the lists
// disagree, the definitions record what each says, and Y29 fixes them one by
// one (2D: the intro gains grant's line; 2E: the schemas).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { installedCommands } from '../lib/installed-commands.ts';
import {
  CommandDefinitionError,
  confirmationText,
  createCommandRegistry,
  commandHelpSpecs,
  flagsSectionLines,
  introBriefs,
  toolArgv,
  toolPassThroughFlags,
  NETWORK_PARAM,
  type CommandDefinition,
  type ToolDefinition,
} from '../lib/command-definition.ts';
import { getValidNetworkNames } from '../lib/network.ts';
import { CONFIRM_TOOL, listedTools } from '../lib/mcp/registry-tools.ts';
import { COMMAND_FLAGS, GLOBAL_FLAGS } from '../lib/command-flags.ts';
import { commandNeedsWalletSdk, dispatchCommand, type ShellProvisions } from '../lib/command-dispatch.ts';
import { FULL_FLAG, parseArgs, type ParsedArgs } from '../lib/argv.ts';
import { isUsageError } from '../lib/errors.ts';
import type { Payer } from '../lib/payer.ts';
import type { WalletProtector } from '../lib/wallet-protector.ts';
import { COMMAND_SPECS } from '../commands/help.ts';
import { COMMAND_BRIEFS } from '../ui/art.ts';
import { TOOLS, REQUIRES_CONFIRMATION, describePendingOp, handlerLoaders } from '../lib/mcp/tools.ts';

const SRC = join(import.meta.dirname, '..');
const registry = installedCommands;

describe('the dispatch (src/lib/command-dispatch.ts, from the registry since 2C)', () => {
  // What the switch in src/wallet.ts gave each command before 2C, as it was
  // read from that switch at b5dc946: the registry's dispatch must give the same.
  const GENERATE_NOTICE = '\n  Note: "midnight generate" is deprecated.\n  Use "midnight wallet generate <name>" instead.\n\n';
  const STATUS_REFUSAL = 'The "status" command is currently being reworked. Check back soon.';
  const SWITCH_BEFORE_2C: Record<string, { signal?: true; payer?: true; protectors?: true; notice?: string; unavailable?: string }> = {
    'address': {}, 'airdrop': { signal: true }, 'balance': {}, 'cache': {}, 'config': {},
    'contract': { signal: true, payer: true }, 'dev': { signal: true, payer: true }, 'dust': { signal: true },
    'generate': { notice: GENERATE_NOTICE }, 'genesis-address': {}, 'grant': { signal: true, payer: true },
    'help': {}, 'info': {}, 'inspect-cost': {}, 'localnet': {}, 'manual': {}, 'serve': { signal: true },
    'status': { unavailable: STATUS_REFUSAL }, 'test': { signal: true }, 'transfer': { signal: true },
    'wallet': { protectors: true },
  };

  it('gives every command what the switch gave it', () => {
    const given = Object.fromEntries(registry.commands.map((c) => [c.name, { ...c.shell }]));
    expect(given).toStrictEqual(SWITCH_BEFORE_2C);
  });

  it('loads each handler from its own command\'s module', async () => {
    for (const c of registry.commands.filter((c) => c.shell.unavailable === undefined)) {
      const fromModule = await import(`../commands/${c.name}.ts`);
      expect((await c.load()).default, c.name).toBe(fromModule.default);
    }
  }, 120_000);

  // A registry of test commands whose handlers record what they were given.
  const received: { name: string; args: ParsedArgs; signal: AbortSignal | undefined; context: unknown }[] = [];
  const notices: string[] = [];
  const loaded: string[] = [];
  const payer = { name: 'test payer' } as unknown as Payer;
  const protector = { name: 'test protector' } as unknown as WalletProtector;
  const testCommand = (name: string, shell: CommandDefinition['shell']): CommandDefinition => ({
    name, flags: [], needsWalletSdk: false, shell,
    load: async () => {
      loaded.push(name);
      return { default: async (args, signal, context) => { received.push({ name, args, signal, context }); } };
    },
  });
  const testRegistry = createCommandRegistry([
    testCommand('plain', {}),
    testCommand('cancellable', { signal: true }),
    testCommand('paying', { signal: true, payer: true }),
    testCommand('protecting', { protectors: true }),
    testCommand('noticed', { notice: 'deprecated\n' }),
    testCommand('refused', { unavailable: 'not now' }),
  ], []);
  const controller = new AbortController();
  const provisions: ShellProvisions = {
    signal: controller.signal,
    loadPayer: async () => payer,
    loadProtectors: async () => [protector],
    writeNotice: (text) => notices.push(text),
  };
  const run = async (name: string) => {
    received.length = 0; notices.length = 0; loaded.length = 0;
    const args = parseArgs([name, '--json']);
    await dispatchCommand(testRegistry, name, args, provisions);
    return { args, call: received[0]! };
  };

  it('passes the args, and the signal, payer and protectors only when the definition asks', async () => {
    const plain = await run('plain');
    expect(plain.call).toStrictEqual({ name: 'plain', args: plain.args, signal: undefined, context: undefined });
    expect((await run('cancellable')).call).toMatchObject({ signal: controller.signal, context: undefined });
    expect((await run('paying')).call).toMatchObject({ signal: controller.signal, context: { payer } });
    const protecting = await run('protecting');
    expect(protecting.call.signal).toBeUndefined();
    expect(protecting.call.context).toStrictEqual({ protectors: [protector] });
  });

  it('writes a notice before the handler loads', async () => {
    await run('noticed');
    expect(notices).toStrictEqual(['deprecated\n']);
    expect(loaded).toStrictEqual(['noticed']);
  });

  it('refuses an unavailable command with its message, loading nothing', async () => {
    loaded.length = 0;
    await expect(dispatchCommand(testRegistry, 'refused', parseArgs(['refused']), provisions)).rejects.toThrow(new Error('not now'));
    expect(loaded).toStrictEqual([]);
  });

  it('refuses status, as the switch did, without loading it', async () => {
    const err = await dispatchCommand(registry, 'status', parseArgs(['status']), provisions).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isUsageError(err)).toBe(false);
    expect((err as Error).message).toBe(STATUS_REFUSAL);
  });

  it('refuses a command not installed as a usage error naming it', async () => {
    const err = await dispatchCommand(registry, 'no-such-command', parseArgs(['no-such-command']), provisions).catch((e: unknown) => e);
    expect(isUsageError(err)).toBe(true);
    expect((err as Error).message).toBe('Unknown command: "no-such-command"\nRun "midnight help" to see available commands.');
  });
});

describe('the commands that need the wallet SDK (heap re-exec and forced exit)', () => {
  // FACADE_COMMANDS in src/wallet.ts before 2C.
  const FACADE_COMMANDS_BEFORE_2C = ['airdrop', 'transfer', 'dust', 'balance', 'serve', 'test', 'contract', 'dev', 'grant'];

  it('are the ones FACADE_COMMANDS listed', () => {
    const rebuilt = registry.commands.filter((c) => commandNeedsWalletSdk(registry, c.name)).map((c) => c.name);
    expect(new Set(rebuilt)).toStrictEqual(new Set(FACADE_COMMANDS_BEFORE_2C));
    expect(rebuilt).toHaveLength(FACADE_COMMANDS_BEFORE_2C.length);
  });

  it('do not include a command that is not installed', () => {
    expect(commandNeedsWalletSdk(registry, 'no-such-command')).toBe(false);
  });
});

describe('the accepted flags (COMMAND_FLAGS and GLOBAL_FLAGS, superseded by the registry; removal waits for Y13)', () => {
  it('COMMAND_FLAGS is rebuilt exactly, each command\'s flags in their order', () => {
    const rebuilt = Object.fromEntries(registry.commands.map((c) => [c.name, c.flags.map((f) => f.name)]));
    expect(rebuilt).toStrictEqual(COMMAND_FLAGS);
  });

  it('GLOBAL_FLAGS is rebuilt exactly', () => {
    expect(registry.globalFlags.map((f) => f.name)).toStrictEqual(GLOBAL_FLAGS);
  });

  it('a flag takes a value exactly when the code reads one for it', () => {
    // getFlag/requireFlag read a value, hasFlag a bare switch, wherever in src/ a flag is read.
    const kinds = new Map<string, Set<boolean>>();
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== '__tests__') scan(path); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        for (const m of readFileSync(path, 'utf8').matchAll(/(getFlag|requireFlag|hasFlag)\(\s*\w+\s*,\s*['"]([a-z0-9-]+)['"]/g)) {
          kinds.set(m[2]!, (kinds.get(m[2]!) ?? new Set()).add(m[1] !== 'hasFlag'));
        }
      }
    };
    scan(SRC);
    // The grant request's limits are read in a loop over their names (LIMIT_FLAGS in lib/grant/request.ts), as values.
    for (const limit of ['cap', 'per-call', 'max-coin', 'expires-in']) kinds.set(limit, new Set([true]));
    for (const command of registry.commands) {
      for (const flag of [...command.flags, ...registry.globalFlags]) {
        const read = kinds.get(flag.name);
        if (['help', 'h', 'version', 'v'].includes(flag.name)) {
          // The shell reads these with hasFlag; it is not scanned as a command.
          expect(flag.takesValue, flag.name).toBe(false);
          continue;
        }
        expect(read, `${command.name} --${flag.name} is read somewhere`).toBeDefined();
        expect([...read!], `${command.name} --${flag.name}`).toStrictEqual([flag.takesValue]);
      }
    }
  });
});

describe('help\'s command specs (COMMAND_SPECS in src/commands/help.ts, superseded by the registry; removal waits for Y13)', () => {
  // What help, help --json and the manual render since 2D.
  const rebuilt = commandHelpSpecs(registry);

  it('is rebuilt exactly, in its order', () => {
    expect(rebuilt).toStrictEqual(COMMAND_SPECS);
  });

  it('is rebuilt byte for byte as help --json and the manual read it', () => {
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(COMMAND_SPECS));
  });
});

describe('the intro\'s briefs (COMMAND_BRIEFS in src/ui/art.ts, superseded by the registry; removal waits for Y13)', () => {
  it('is rebuilt exactly, in its order, with grant\'s line added after dev (Y29)', () => {
    const before = [...COMMAND_BRIEFS];
    const dev = before.findIndex(([name]) => name === 'dev');
    before.splice(dev + 1, 0, ['grant', 'Grants that let agents spend']);
    expect(introBriefs(registry)).toStrictEqual(before);
  });

  it('names every command help lists but generate (wallet generate in the intro), and not status (disabled)', () => {
    const listed = new Set(introBriefs(registry).map(([name]) => name));
    const missing = commandHelpSpecs(registry).map((spec) => spec.name).filter((name) => !listed.has(name));
    expect(missing).toStrictEqual(['generate']);
    expect(listed.has('status')).toBe(false);
  });
});

describe('the MCP server\'s handler loaders (handlerLoaders in src/lib/mcp/tools.ts)', () => {
  it('names the same commands', () => {
    const rebuilt = registry.commands.filter((c) => c.mcp !== undefined).map((c) => c.name).sort();
    expect(rebuilt).toStrictEqual(Object.keys(handlerLoaders).sort());
  });

  it('loads the same handler for each', async () => {
    for (const [name, loader] of Object.entries(handlerLoaders)) {
      expect((await registry.find(name)!.load()).default, name).toBe((await loader()).default);
    }
  }, 120_000);
});

describe('the MCP tools, generated from the registry (TOOLS in src/lib/mcp/tools.ts, superseded by the registry; removal waits for Y13)', () => {
  const tools = listedTools(registry);
  const before = (name: string) => TOOLS.find((t) => t.name === name)!;

  // The parameters each tool's schema gains in 2E (Y29): flags of its command
  // that agents could pass but not see. Nothing else of tools/list changes.
  const ADDED_IN_2E: Record<string, string[]> = {
    midnight_info: ['network'],
    midnight_balance: ['force-shielded', 'no-cache', 'seed', 'shielded', 'node', 'proof-server'],
    midnight_address: ['wallet'],
    midnight_airdrop: ['network', 'node', 'indexer-ws', 'proof-server'],
    midnight_transfer: ['force-shielded', 'network', 'shielded', 'node', 'indexer-ws', 'proof-server'],
    midnight_dust_register: ['network', 'node', 'indexer-ws', 'proof-server'],
    midnight_dust_status: ['network'],
    midnight_contract_state: ['node', 'indexer-ws', 'proof-server'],
    midnight_contract_deploy: ['secret-key', 'node', 'indexer-ws', 'proof-server'],
    midnight_contract_call: ['node', 'indexer-ws', 'proof-server'],
    ...Object.fromEntries(['status', 'list', 'request', 'deploy', 'deposit', 'issue', 'revoke', 'revoke_all']
      .map((sub) => [`midnight_grant_${sub}`, ['node', 'indexer-ws', 'proof-server']])),
  };

  it('lists the same tools in the same order, the server\'s confirm tool last, as it was', () => {
    expect(tools.map((t) => t.name)).toStrictEqual(TOOLS.map((t) => t.name));
    expect(tools.at(-1)).toStrictEqual(CONFIRM_TOOL);
    expect(JSON.stringify(CONFIRM_TOOL.inputSchema)).toBe(JSON.stringify(before('midnight_confirm_operation').inputSchema));
  });

  it('keeps every name, description, annotation and required list byte for byte', () => {
    for (const tool of tools) {
      const old = before(tool.name);
      expect(JSON.stringify([tool.name, tool.description, tool.annotations, tool.inputSchema.required]), tool.name)
        .toBe(JSON.stringify([old.name, old.description, old.annotations, old.inputSchema.required]));
      expect(Object.keys(tool.inputSchema), tool.name).toStrictEqual(Object.keys(old.inputSchema));
    }
  });

  it('keeps every property each schema had, in its place and as it read, and adds only the flags agents could already pass', () => {
    for (const tool of tools) {
      const old = before(tool.name).inputSchema.properties;
      const keys = Object.keys(tool.inputSchema.properties);
      const kept = Object.fromEntries(keys.slice(0, Object.keys(old).length).map((k) => [k, tool.inputSchema.properties[k]]));
      expect(JSON.stringify(kept), tool.name).toBe(JSON.stringify(old));
      expect(keys.slice(Object.keys(old).length), tool.name).toStrictEqual(ADDED_IN_2E[tool.name] ?? []);
    }
  });

  it('adds only parameters 2C already let through, so no call that ran before is refused', () => {
    for (const tool of registry.tools) {
      for (const name of ADDED_IN_2E[tool.name] ?? []) expect(toolPassThroughFlags(registry, tool.name), `${tool.name}: ${name}`).toContain(name);
    }
  });

  it('has, in each schema, exactly the tool\'s own params and the flags of its command that agents may pass and that apply to its subcommand', () => {
    for (const tool of registry.tools) {
      const sub = tool.argv.subcommand;
      const own = tool.params.flatMap((p) => ('name' in p ? [p.name] : []));
      const placed = tool.params.flatMap((p) => ('flag' in p ? [p.flag] : []));
      const visible = [...tool.command.flags, ...registry.globalFlags]
        .filter((f) => f.agent !== undefined && !('notForAgents' in f.agent))
        .filter((f) => f.subcommands === undefined || (typeof sub === 'string' && f.subcommands.includes(sub)))
        .map((f) => f.name);
      const expected = tool.argv.flags === 'rest' ? [...own, ...placed, ...visible.filter((f) => !placed.includes(f))] : [...own, ...placed];
      expect(new Set(Object.keys(tool.inputSchema.properties)), tool.name).toStrictEqual(new Set(expected));
      for (const name of placed) expect(visible, `${tool.name} places --${name}`).toContain(name);
      for (const name of own) expect(tool.command.flags.map((f) => f.name), `${tool.name}: ${name}`).not.toContain(name);
    }
  });

  it('shows no flag agents never pass: --verbose, --json, the shell\'s, grant\'s --yes, transfer\'s and airdrop\'s refused --no-cache', () => {
    for (const tool of registry.tools) {
      for (const name of ['verbose', 'json', 'help', 'h', 'version', 'v', 'yes']) expect(Object.keys(tool.inputSchema.properties), tool.name).not.toContain(name);
    }
    for (const name of ['midnight_transfer', 'midnight_airdrop']) {
      expect(Object.keys(tools.find((t) => t.name === name)!.inputSchema.properties)).not.toContain('no-cache');
    }
  });

  it('shows a network as one of the networks mn knows', () => {
    expect(NETWORK_PARAM.enum).toStrictEqual(getValidNetworkNames());
  });

  it('needs confirmation for the same tools', () => {
    const rebuilt = new Set(registry.tools.filter((t) => t.confirmation !== undefined).map((t) => t.name));
    expect(rebuilt).toStrictEqual(REQUIRES_CONFIRMATION);
    // Every one checks the call before a token is given, as each had a check.
    for (const tool of registry.tools.filter((t) => t.confirmation !== undefined)) expect(tool.confirmation!.check, tool.name).toBeTypeOf('function');
  });

  it('gives each confirmation the same text', () => {
    const samples: Record<string, unknown>[] = [
      {},
      { network: 'preprod' },
      { wallet: 'alice', network: 'undeployed', amount: '5', to: 'mn_addr_undeployed1x', args: '[1,2]', path: './dapp', circuit: 'inc', address: '0xab', grant: '3', link: 'l' },
      { wallet: null, network: null, args: '', path: undefined },
    ];
    const confirmed = registry.tools.filter((t) => t.confirmation !== undefined);
    expect(confirmed.length).toBe(REQUIRES_CONFIRMATION.size);
    for (const tool of confirmed) {
      for (const params of samples) {
        expect(confirmationText(tool, params), `${tool.name} ${JSON.stringify(params)}`).toBe(describePendingOp(tool.name, params));
      }
    }
  });

  it('lets a tool pass on its command\'s flags beyond its schema only when its argv passes the rest on (2C\'s rule, superseded by the schema)', () => {
    expect(toolPassThroughFlags(registry, 'midnight_transfer')).toStrictEqual([
      ...registry.find('transfer')!.flags.map((f) => f.name), 'help', 'h', 'json', 'version', 'v',
    ]);
    expect(toolPassThroughFlags(registry, 'midnight_config_get')).toStrictEqual([]);
    expect(toolPassThroughFlags(registry, 'midnight_confirm_operation')).toStrictEqual([]);
  });

  it('maps only parameters its schema has onto argv', () => {
    for (const tool of registry.tools) {
      const params = Object.keys(tool.inputSchema.properties);
      const sub = tool.argv.subcommand;
      const named = [
        ...(typeof sub === 'object' ? [sub.param] : []),
        ...(tool.argv.positionals ?? []),
        ...(tool.argv.flags === 'rest' ? [] : tool.argv.flags),
      ];
      for (const name of named) expect(params, `${tool.name}: ${name}`).toContain(name);
    }
  });

  // The argv each tool's own handler built before 2E (src/lib/mcp/tools.ts at
  // 03b55c4), for a call with these parameters. The generic mapping must
  // build the same.
  const args = (command: string, subcommand: string | undefined, positionals: string[], flags: Record<string, string | true>): ParsedArgs =>
    ({ command, subcommand, positionals, flags: { json: true, ...flags } });
  const ARGV_BEFORE_2E: [tool: string, params: Record<string, unknown>, argv: ParsedArgs][] = [
    ['midnight_wallet_generate', { name: 'alice', network: 'preprod', seed: 'ab', force: 'true' }, args('wallet', 'generate', ['alice'], { network: 'preprod', seed: 'ab', force: true })],
    ['midnight_wallet_generate', { name: 'alice', mnemonic: 'w o r d s', force: true }, args('wallet', 'generate', ['alice'], { mnemonic: 'w o r d s', force: true })],
    ['midnight_wallet_list', {}, args('wallet', 'list', [], {})],
    ['midnight_wallet_list', { full: true }, args('wallet', 'list', [], { [FULL_FLAG]: true })],
    ['midnight_wallet_list', { full: false }, args('wallet', 'list', [], {})],
    ['midnight_wallet_use', { name: 'bob' }, args('wallet', 'use', ['bob'], {})],
    ['midnight_wallet_info', {}, args('wallet', 'info', [], {})],
    ['midnight_wallet_info', { name: '', full: true }, args('wallet', 'info', [], { [FULL_FLAG]: true })],
    ['midnight_wallet_info', { name: 'bob' }, args('wallet', 'info', ['bob'], {})],
    ['midnight_wallet_remove', { name: 'bob' }, args('wallet', 'remove', ['bob'], {})],
    ['midnight_info', { wallet: 'alice' }, args('info', undefined, [], { wallet: 'alice' })],
    ['midnight_balance', { address: 'mn_addr_x', network: 'preview', 'indexer-ws': 'ws://i', full: true }, args('balance', 'mn_addr_x', [], { network: 'preview', 'indexer-ws': 'ws://i', [FULL_FLAG]: true })],
    ['midnight_balance', { wallet: 'alice' }, args('balance', undefined, [], { wallet: 'alice' })],
    ['midnight_address', { seed: 'ab', index: '2', network: 'undeployed' }, args('address', undefined, [], { seed: 'ab', index: '2', network: 'undeployed' })],
    ['midnight_genesis_address', { network: 'undeployed' }, args('genesis-address', undefined, [], { network: 'undeployed' })],
    ['midnight_inspect_cost', {}, args('inspect-cost', undefined, [], {})],
    ['midnight_inspect_cost', { network: 'preprod' }, args('inspect-cost', undefined, [], { network: 'preprod' })],
    ['midnight_airdrop', { amount: '10', wallet: 'bob', shielded: 'true' }, args('airdrop', '10', [], { wallet: 'bob', shielded: 'true' })],
    ['midnight_transfer', { to: 'bob', amount: '1', wallet: 'alice', network: 'undeployed' }, args('transfer', 'bob', ['1'], { wallet: 'alice', network: 'undeployed' })],
    ['midnight_transfer', { to: 'bob' }, args('transfer', 'bob', [], {})],
    ['midnight_dust_register', { wallet: 'alice' }, args('dust', 'register', [], { wallet: 'alice' })],
    ['midnight_dust_status', { 'no-cache': 'true', node: 'ws://n', full: true }, args('dust', 'status', [], { 'no-cache': 'true', node: 'ws://n', [FULL_FLAG]: true })],
    ['midnight_config_get', { key: 'node', network: 'preview' }, args('config', 'get', ['node'], { network: 'preview' })],
    ['midnight_config_get', { key: 'network', network: '' }, args('config', 'get', ['network'], {})],
    ['midnight_config_set', { key: 'node', value: 'ws://n', network: 'preview' }, args('config', 'set', ['node', 'ws://n'], { network: 'preview' })],
    ['midnight_config_unset', { key: 'node' }, args('config', 'unset', ['node'], {})],
    ['midnight_cache_clear', { network: 'preprod', wallet: 'alice' }, args('cache', 'clear', [], { network: 'preprod', wallet: 'alice' })],
    ['midnight_localnet_up', {}, args('localnet', 'up', [], {})],
    ['midnight_localnet_stop', {}, args('localnet', 'stop', [], {})],
    ['midnight_localnet_down', {}, args('localnet', 'down', [], {})],
    ['midnight_localnet_status', {}, args('localnet', 'status', [], {})],
    ['midnight_localnet_clean', {}, args('localnet', 'clean', [], {})],
    ['midnight_localnet_logs', {}, args('localnet', 'logs', [], { tail: '200' })],
    ['midnight_localnet_logs', { tail: '50' }, args('localnet', 'logs', [], { tail: '50' })],
    ['midnight_contract_inspect', { path: './d', name: 'c' }, args('contract', 'inspect', [], { path: './d', name: 'c' })],
    ['midnight_contract_state', { address: 'ab', network: 'undeployed' }, args('contract', 'state', [], { address: 'ab', network: 'undeployed' })],
    ['midnight_contract_deploy', { wallet: 'alice', args: '[1]', path: './d' }, args('contract', 'deploy', [], { wallet: 'alice', args: '[1]', path: './d' })],
    ['midnight_contract_call', { address: 'ab', circuit: 'inc', args: '[]' }, args('contract', 'call', [], { address: 'ab', circuit: 'inc', args: '[]' })],
    ['midnight_grant_status', { wallet: 'alice', network: 'undeployed' }, args('grant', 'status', [], { wallet: 'alice', network: 'undeployed' })],
    ['midnight_grant_list', {}, args('grant', 'list', [], {})],
    ['midnight_grant_request', { link: 'L', cap: '5' }, args('grant', 'issue', ['L'], { cap: '5' })],
    ['midnight_grant_deploy', { network: 'undeployed' }, args('grant', 'deploy', [], { network: 'undeployed' })],
    ['midnight_grant_deposit', { amount: '1.5', wallet: 'alice' }, args('grant', 'deposit', ['1.5'], { wallet: 'alice' })],
    ['midnight_grant_issue', { link: 'L', 'per-call': '2' }, args('grant', 'issue', ['L'], { 'per-call': '2', yes: true })],
    ['midnight_grant_revoke', { grant: '3' }, args('grant', 'revoke', ['3'], {})],
    ['midnight_grant_revoke_all', {}, args('grant', 'revoke-all', [], {})],
    ['midnight_test_create', { path: './d', 'no-ai': true, force: false, port: '4173' }, args('test', 'create', [], { path: './d', 'no-ai': true, port: '4173' })],
  ];

  it('builds the argv each tool\'s own handler built', () => {
    for (const [name, params, expected] of ARGV_BEFORE_2E) {
      const tool = registry.tools.find((t) => t.name === name)!;
      expect(toolArgv(tool, params), `${name} ${JSON.stringify(params)}`).toStrictEqual(expected);
    }
    // Every tool is covered.
    expect(new Set(ARGV_BEFORE_2E.map(([name]) => name))).toStrictEqual(new Set(registry.tools.map((t) => t.name)));
  });
});

describe('createCommandRegistry', () => {
  const base: CommandDefinition = {
    name: 'x',
    flags: [{ name: 'a', takesValue: false, help: ['--a   A'] }],
    help: { description: 'X', usage: 'midnight x', flags: ['note', { flag: 'a' }] },
    needsWalletSdk: false,
    shell: {},
    load: async () => ({ default: async () => {} }),
  };

  it('renders the Flags section from its lines and the flags\' own help', () => {
    expect(flagsSectionLines(base)).toStrictEqual(['note', '--a   A']);
  });

  it('refuses a command defined twice', () => {
    expect(() => createCommandRegistry([base, base], [])).toThrow(CommandDefinitionError);
  });

  it('refuses help that shows a flag with no help lines, or a flag\'s help that help never shows', () => {
    expect(() => createCommandRegistry([{ ...base, help: { ...base.help!, flags: [{ flag: 'b' }] } }], [])).toThrow(/--b/);
    expect(() => createCommandRegistry([{ ...base, help: { ...base.help!, flags: [] } }], [])).toThrow(/--a has help lines/);
  });

  it('refuses a flag tied to a subcommand the command lacks', () => {
    expect(() => createCommandRegistry([{ ...base, flags: [{ name: 'a', takesValue: false, subcommands: ['nope'] }], help: undefined }], [])).toThrow(/"nope"/);
  });

  const tool: ToolDefinition = { name: 't', description: 'T', params: [], argv: { flags: [] }, order: 1 };
  const withTools = (flags: CommandDefinition['flags'], ...tools: ToolDefinition[]): CommandDefinition =>
    ({ ...base, subcommands: ['s', 'r'], flags, help: undefined, mcp: { tools } });

  it('refuses two tools with one name or one place', () => {
    expect(() => createCommandRegistry([{ ...base, mcp: { tools: [tool, tool] } }], [])).toThrow(/MCP tool "t"/);
    expect(() => createCommandRegistry([{ ...base, mcp: { tools: [tool, { ...tool, name: 'u' }] } }], [])).toThrow(/place "1"/);
  });

  it('generates a tool\'s schema: its params in order, then the flags it passes on that agents may pass and apply to its subcommand', () => {
    const registry = createCommandRegistry([withTools([
      { name: 'z', takesValue: true, agent: { type: 'string', description: 'Z' } },
      { name: 'only-r', takesValue: true, subcommands: ['r'], agent: { type: 'string' } },
      { name: 'loud', takesValue: false, agent: { notForAgents: 'a terminal\'s' } },
      { name: 'a', takesValue: true, subcommands: ['s'], agent: { type: 'string', enum: ['x'] } },
    ], {
      ...tool,
      params: [{ name: 'id', schema: { type: 'string' } }, { flag: 'a', schema: { type: 'string', description: 'as shown before' } }],
      required: ['id'],
      argv: { subcommand: 's', positionals: ['id'], flags: 'rest' },
    })], [{ name: 'json', takesValue: false, agent: { notForAgents: 'set by the server' } }]);
    expect(JSON.stringify(registry.tools[0]!.inputSchema)).toBe(JSON.stringify({
      type: 'object',
      properties: { id: { type: 'string' }, a: { type: 'string', description: 'as shown before' }, z: { type: 'string', description: 'Z' } },
      required: ['id'],
    }));
  });

  it('refuses a tool that places a flag its command lacks, one hidden from agents, or one not of its subcommand', () => {
    const flags = [
      { name: 'hidden', takesValue: false, agent: { notForAgents: 'why' } },
      { name: 'only-r', takesValue: true, subcommands: ['r'], agent: { type: 'string' as const } },
    ];
    const placing = (flag: string) => withTools(flags, { ...tool, params: [{ flag }], argv: { subcommand: 's', flags: [flag] } });
    expect(() => createCommandRegistry([placing('nope')], [])).toThrow(/--nope, which x doesn't accept/);
    expect(() => createCommandRegistry([placing('hidden')], [])).toThrow(/--hidden, which says no schema/);
    expect(() => createCommandRegistry([placing('only-r')], [])).toThrow(/--only-r, which doesn't apply/);
  });

  it('refuses a tool passing the rest on when a flag of its subcommand says neither how agents see it nor why not', () => {
    const rest = { ...tool, argv: { subcommand: 's', flags: 'rest' as const } };
    expect(() => createCommandRegistry([withTools([{ name: 'quiet', takesValue: false }], rest)], [])).toThrow(/--quiet on, which says neither/);
    // A flag of another subcommand needs nothing.
    expect(() => createCommandRegistry([withTools([{ name: 'quiet', takesValue: false, subcommands: ['r'] }], rest)], [])).not.toThrow();
    // Nor does a global flag, which the tool passes on too.
    expect(() => createCommandRegistry([withTools([], rest)], [{ name: 'json', takesValue: false }])).toThrow(/--json on, which says neither/);
  });

  it('refuses an own parameter named like a flag, a mapping to a parameter it lacks, and a required one its schema lacks', () => {
    const flags = [{ name: 'a', takesValue: true, agent: { type: 'string' as const } }];
    expect(() => createCommandRegistry([withTools(flags, { ...tool, params: [{ name: 'a', schema: { type: 'string' } }] })], [])).toThrow(/"a" is also a flag/);
    expect(() => createCommandRegistry([withTools(flags, { ...tool, argv: { positionals: ['id'], flags: [] } })], [])).toThrow(/"id" fills/);
    expect(() => createCommandRegistry([withTools(flags, { ...tool, argv: { flags: ['a'] } })], [])).toThrow(/passes "a"/);
    expect(() => createCommandRegistry([withTools(flags, { ...tool, required: ['b'] })], [])).toThrow(/requires "b"/);
  });
});
