// The command registry (plan 2B): every command defined once, beside it.
// Since 2C the CLI's dispatch, its SDK commands and its accepted flags come
// from it, since 2D help, the manual and the intro, and since 2E the MCP
// server's tools. The lists they replaced are gone (Y13); what each output
// says is pinned by the behaviour snapshot, and the tests here check what the
// registry must hold on its own.

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
import { commandNeedsWalletSdk, dispatchCommand, type ShellProvisions } from '../lib/command-dispatch.ts';
import { FULL_FLAG, parseArgs, type ParsedArgs } from '../lib/argv.ts';
import { CancelledError, isUsageError } from '../lib/errors.ts';
import { classifyError, EXIT_CANCELLED } from '../lib/exit-codes.ts';
import type { CallContext, CommandOutcome } from '../lib/call-context.ts';
import { hostPaths } from '../lib/state-root.ts';
import { settings } from '../lib/settings.ts';
import type { Payer } from '../lib/payer.ts';
import { createSdkWarningRouter, sdkWarningCallsOn } from '../lib/sdk-warnings.ts';
import type { WalletProtector } from '../lib/wallet-protector.ts';

const SRC = join(import.meta.dirname, '..');
const registry = installedCommands;

describe('the dispatch (src/lib/command-dispatch.ts, from the registry since 2C)', () => {
  // What the switch in src/wallet.ts gave each command before 2C, as it was
  // read from that switch at b5dc946: the registry's dispatch must give the same.
  const GENERATE_NOTICE = '\n  Note: "midnight generate" is deprecated.\n  Use "midnight wallet generate <name>" instead.\n\n';
  const STATUS_REFUSAL = 'The "status" command is currently being reworked. Check back soon.';
  // Since 2F every handler gets its call's signal, so the definitions no longer say which do (decision 2).
  const SWITCH_BEFORE_2C: Record<string, { payer?: true; protectors?: true; notice?: string; unavailable?: string }> = {
    'address': {}, 'airdrop': {}, 'balance': {}, 'cache': {}, 'config': {},
    'contract': { payer: true }, 'dev': { payer: true }, 'dust': {},
    'generate': { notice: GENERATE_NOTICE }, 'genesis-address': {}, 'grant': { payer: true },
    'help': {}, 'info': {}, 'inspect-cost': {}, 'localnet': {}, 'manual': {}, 'serve': {},
    'status': { unavailable: STATUS_REFUSAL }, 'test': {}, 'transfer': {},
    'wallet': { protectors: true },
  };

  it('gives every command what the switch gave it, the signal now to every one', () => {
    const given = Object.fromEntries(registry.commands.map((c) => [c.name, { ...c.shell }]));
    expect(given).toStrictEqual(SWITCH_BEFORE_2C);
  });

  it('loads each handler from its own command\'s module', async () => {
    for (const c of registry.commands.filter((c) => c.shell.unavailable === undefined)) {
      const fromModule = await import(`../commands/${c.name}.ts`);
      expect((await c.load()).default, c.name).toBe(fromModule.default);
    }
  }, 120_000);

  // A registry of test commands whose handlers record the context they were given.
  const received: { name: string; args: ParsedArgs; ctx: CallContext }[] = [];
  const notices: string[] = [];
  const results: unknown[] = [];
  const loaded: string[] = [];
  const payer = { name: 'test payer' } as unknown as Payer;
  const protector = { name: 'test protector' } as unknown as WalletProtector;
  const testCommand = (name: string, shell: CommandDefinition['shell'], outcome?: CommandOutcome): CommandDefinition => ({
    name, order: 1, flags: [], needsWalletSdk: false, shell,
    load: async () => {
      loaded.push(name);
      return {
        default: async (args, ctx) => {
          received.push({ name, args, ctx });
          ctx.output.result({ ran: name });
          return outcome;
        },
      };
    },
  });
  const testRegistry = createCommandRegistry([
    testCommand('plain', {}),
    testCommand('paying', { payer: true }),
    testCommand('protecting', { protectors: true }),
    testCommand('noticed', { notice: 'deprecated\n' }),
    testCommand('refused', { unavailable: 'not now' }),
    testCommand('failing', {}, { exitCode: 3 }),
  ], []);
  const controller = new AbortController();
  const output = {
    result: (data: Readonly<Record<string, unknown>>) => { results.push(data); },
    stdout: () => {},
    stderr: (text: string) => { notices.push(text); },
  };
  const provisions: ShellProvisions = {
    signal: controller.signal,
    output,
    sdkWarnings: sdkWarningCallsOn(createSdkWarningRouter()),
    loadPayer: async () => payer,
    loadProtectors: async () => [protector],
  };
  const run = async (name: string, given: ShellProvisions = provisions) => {
    received.length = 0; notices.length = 0; loaded.length = 0; results.length = 0;
    const args = parseArgs([name, '--json']);
    const outcome = await dispatchCommand(testRegistry, name, args, given);
    return { args, call: received[0]!, outcome };
  };

  it('gives every handler its call\'s signal and output, and the payer and protectors only when the definition asks', async () => {
    const plain = await run('plain');
    expect(plain.call.args).toBe(plain.args);
    expect(plain.call.ctx.signal).toBe(controller.signal);
    expect(plain.call.ctx.payer).toBeUndefined();
    expect(plain.call.ctx.protectors).toBeUndefined();
    expect(results).toStrictEqual([{ ran: 'plain' }]);
    const paying = await run('paying');
    expect(paying.call.ctx.signal).toBe(controller.signal);
    expect(paying.call.ctx.payer).toBe(payer);
    expect(paying.call.ctx.protectors).toBeUndefined();
    const protecting = await run('protecting');
    expect(protecting.call.ctx.signal).toBe(controller.signal);
    expect(protecting.call.ctx.payer).toBeUndefined();
    expect(protecting.call.ctx.protectors).toStrictEqual([protector]);
  });

  it('gives the handler the configuration the host gives when the call starts, and --verbose', async () => {
    const { ctx } = (await run('plain')).call;
    expect(ctx.config.paths).toStrictEqual(hostPaths());
    expect(ctx.config.settings).toStrictEqual(settings());
    expect(ctx.diagnostics.isVerbose).toBe(false);
    received.length = 0;
    await dispatchCommand(testRegistry, 'plain', parseArgs(['plain', '--verbose']), provisions);
    expect(received[0]!.ctx.diagnostics.isVerbose).toBe(true);
  });

  it('returns the exit code the handler gives, for the shell to set', async () => {
    expect((await run('failing')).outcome).toStrictEqual({ exitCode: 3 });
    expect((await run('plain')).outcome).toBeUndefined();
  });

  it('never starts a call already cancelled: CANCELLED, the handler not run', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const err = await run('plain', { ...provisions, signal: cancelled.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelledError);
    expect(classifyError(err as Error)).toStrictEqual({ exitCode: EXIT_CANCELLED, errorCode: 'CANCELLED' });
    expect(received).toStrictEqual([]);
    expect(results).toStrictEqual([]);
  });

  it('writes a notice before the handler loads', async () => {
    await run('noticed');
    expect(notices).toStrictEqual(['deprecated\n']);
    expect(results).toStrictEqual([{ ran: 'noticed' }]);
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

describe('the accepted flags', () => {
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

describe('the intro\'s briefs', () => {
  it('names every command help lists but generate (wallet generate in the intro), and not status (disabled)', () => {
    const listed = new Set(introBriefs(registry).map(([name]) => name));
    const missing = commandHelpSpecs(registry).map((spec) => spec.name).filter((name) => !listed.has(name));
    expect(missing).toStrictEqual(['generate']);
    expect(listed.has('status')).toBe(false);
  });
});

describe('the MCP tools, generated from the registry', () => {
  const tools = listedTools(registry);
  it('lists the registry\'s tools in its order, the server\'s confirm tool last', () => {
    expect(tools.map((t) => t.name)).toStrictEqual([...registry.tools.map((t) => t.name), CONFIRM_TOOL.name]);
    expect(tools.at(-1)).toStrictEqual(CONFIRM_TOOL);
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

  // Confirmed since 2E (Y29): it was marked destructive yet ran at once.
  const NEWLY_CONFIRMED = 'midnight_wallet_remove';

  it('needs confirmation for wallet remove, and every confirmed tool checks the call before a token is given', () => {
    expect(registry.tools.find((t) => t.name === NEWLY_CONFIRMED)!.confirmation).toBeDefined();
    for (const tool of registry.tools.filter((t) => t.confirmation !== undefined)) expect(tool.confirmation!.check, tool.name).toBeTypeOf('function');
  });

  it('describes removing a wallet as deleting its file and seed', () => {
    const remove = registry.tools.find((t) => t.name === NEWLY_CONFIRMED)!;
    expect(confirmationText(remove, { name: 'bob' })).toBe('Remove wallet bob: its file, and the seed in it, is deleted from this machine');
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
    order: 1,
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
