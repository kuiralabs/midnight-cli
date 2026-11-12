// The command registry: every command defined once, beside it. The CLI's
// dispatch, its SDK commands and its accepted flags come from it, and so do
// help, the manual, the intro and the MCP server's tools. The lists they
// replaced are gone; what each output
// says is pinned by the behaviour snapshot, and the tests here check what the
// registry must hold on its own.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFiles } from '../../scripts/check-layering.mjs';
import { installedCommands } from '../lib/installed-commands.ts';
import { confirmationText, createCommandRegistry, commandHelpSpecs, introBriefs, toolArgv, needsConfirmation, NETWORK_PARAM, type CommandDefinition, getValidNetworkNames, FULL_FLAG, parseArgs, type ParsedArgs, CancelledError, isUsageError, classifyError, EXIT_CANCELLED, type CallContext, type CommandOutcome, type Payer, createSdkWarningRouter } from '@kuiralabs/midnight-cli-core';
import { CONFIRM_TOOL, listedTools } from '../lib/mcp/registry-tools.ts';
import { commandNeedsWalletSdk, dispatchCommand, type ShellProvisions } from '../lib/command-dispatch.ts';
import { testHost } from '../../test-support/test-host.ts';
import type { WalletProtector } from '@kuiralabs/midnight-wallet';

const SRC = join(import.meta.dirname, '..');
const registry = installedCommands;

describe('the dispatch (src/lib/command-dispatch.ts, from the registry)', () => {
  // What the switch in src/wallet.ts gave each command before the registry, as it was
  // read from that switch at b5dc946: the registry's dispatch must give the same.
  const GENERATE_NOTICE = '\n  Note: "midnight generate" is deprecated.\n  Use "midnight wallet generate <name>" instead.\n\n';
  const STATUS_REFUSAL = 'The "status" command is currently being reworked. Check back soon.';
  // Every handler gets its call's signal, so the definitions don't say which do.
  const SWITCH_BEFORE_REGISTRY: Record<string, { payer?: true; protectors?: true; notice?: string; unavailable?: string }> = {
    'address': {}, 'airdrop': {}, 'balance': {}, 'cache': {}, 'config': {},
    'contract': { payer: true }, 'dev': { payer: true }, 'dust': {},
    'generate': { notice: GENERATE_NOTICE }, 'genesis-address': {}, 'grant': { payer: true },
    'help': {}, 'info': {}, 'inspect-cost': {}, 'localnet': {}, 'manual': {}, 'serve': {},
    // Added since the registry: swap, which pays through the payer as grant does.
    'swap': { payer: true },
    // And tx, which reads the indexer only.
    'tx': {},
    'status': { unavailable: STATUS_REFUSAL }, 'test': {}, 'transfer': {},
    'wallet': { protectors: true },
  };

  it('gives every command what the switch gave it, the signal now to every one', () => {
    const given = Object.fromEntries(registry.commands.map((c) => [c.name, { ...c.shell }]));
    expect(given).toStrictEqual(SWITCH_BEFORE_REGISTRY);
  });

  it('loads each handler from its own command\'s module', async () => {
    for (const c of registry.commands.filter((c) => c.shell.unavailable === undefined)) {
      // A command's module sits in commands/, under src/ or a workspace package's source.
      const file = sourceFiles().find((f) => f.endsWith(`/commands/${c.name}.ts`))!;
      const fromModule = await import(file);
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
    name, order: 1, flags: [], needsWalletSdk: false, shell, errors: { codes: [] },
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
    host: testHost(),
    payer: async () => payer,
    protectors: async () => [protector],
  };
  const run = async (name: string, given: ShellProvisions = provisions) => {
    received.length = 0; notices.length = 0; loaded.length = 0; results.length = 0;
    const args = parseArgs([name, '--json']);
    const outcome = await dispatchCommand(testRegistry, name, args, given);
    return { args, call: received[0]!, outcome };
  };

  // How a command is run from its definition (notice, refusal, cancellation, exit code) is core's runCommand, tested there.
  it('gives every handler its call\'s signal and output, and the shell\'s payer and protectors only when the definition asks', async () => {
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

  it('refuses status without loading it, as a usage error like a command not installed', async () => {
    const err = await dispatchCommand(registry, 'status', parseArgs(['status']), provisions).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isUsageError(err)).toBe(true);
    expect((err as Error).message).toBe(STATUS_REFUSAL);
  });

  it('refuses a command not installed as a usage error naming it', async () => {
    const err = await dispatchCommand(registry, 'no-such-command', parseArgs(['no-such-command']), provisions).catch((e: unknown) => e);
    expect(isUsageError(err)).toBe(true);
    expect((err as Error).message).toBe('Unknown command: "no-such-command"\nRun "midnight help" to see available commands.');
  });
});

describe('the commands that need the wallet SDK (heap re-exec and forced exit)', () => {
  // FACADE_COMMANDS in src/wallet.ts before the registry.
  // And swap, added since.
  const FACADE_COMMANDS_BEFORE_REGISTRY = ['airdrop', 'transfer', 'dust', 'balance', 'serve', 'test', 'contract', 'dev', 'grant', 'swap'];

  it('are the ones FACADE_COMMANDS listed', () => {
    const rebuilt = registry.commands.filter((c) => commandNeedsWalletSdk(registry, c.name)).map((c) => c.name);
    expect(new Set(rebuilt)).toStrictEqual(new Set(FACADE_COMMANDS_BEFORE_REGISTRY));
    expect(rebuilt).toHaveLength(FACADE_COMMANDS_BEFORE_REGISTRY.length);
  });

  it('do not include a command that is not installed', () => {
    expect(commandNeedsWalletSdk(registry, 'no-such-command')).toBe(false);
  });
});

describe('the accepted flags', () => {
  it('a flag takes a value exactly when the code reads one for it', () => {
    // getFlag/getFlagValues/requireFlag read a value, hasFlag a bare switch, wherever in src/ a flag is read.
    const kinds = new Map<string, Set<boolean>>();
    // src/ and the workspace packages, tests left out.
    for (const path of sourceFiles()) {
      for (const m of readFileSync(path, 'utf8').matchAll(/(getFlagValues|getFlag|requireFlag|hasFlag)\(\s*\w+\s*,\s*['"]([a-z0-9-]+)['"]/g)) {
        kinds.set(m[2]!, (kinds.get(m[2]!) ?? new Set()).add(m[1] !== 'hasFlag'));
      }
    }
    // The grant request's limits are read in a loop over their names (LIMIT_FLAGS in the grant package's lib/grant/request.ts), as values.
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

  // Confirmed since tools came from the registry: it was marked destructive yet ran at once.
  const NEWLY_CONFIRMED = 'midnight_wallet_remove';

  it('needs confirmation for wallet remove, and every confirmed tool checks the call before a token is given', () => {
    expect(registry.tools.find((t) => t.name === NEWLY_CONFIRMED)!.confirmation).toBeDefined();
    for (const tool of registry.tools.filter((t) => t.confirmation !== undefined)) expect(tool.confirmation!.check, tool.name).toBeTypeOf('function');
  });

  it('asks for confirmation on exactly the tools that move funds, change an account or delete a seed', () => {
    // Taking a tool off this list lets an agent run it without the user's confirmation.
    expect(registry.tools.filter((t) => t.confirmation !== undefined).map((t) => t.name).sort()).toStrictEqual([
      'midnight_contract_call', 'midnight_contract_deploy',
      'midnight_grant_deploy', 'midnight_grant_deposit', 'midnight_grant_issue', 'midnight_grant_revoke', 'midnight_grant_revoke_all',
      'midnight_swap_cancel', 'midnight_swap_make', 'midnight_swap_take',
      'midnight_transfer', 'midnight_wallet_generate', 'midnight_wallet_remove',
    ]);
  });

  it('confirms wallet generate only when it may replace a wallet: with force', () => {
    const generate = registry.tools.find((t) => t.name === 'midnight_wallet_generate')!;
    expect(needsConfirmation(generate, { name: 'alice', force: true })).toBe(true);
    expect(needsConfirmation(generate, { name: 'alice', force: false })).toBe(false);
    expect(needsConfirmation(generate, { name: 'alice' })).toBe(false);
    // Every other confirmed tool confirms every call.
    for (const tool of registry.tools.filter((t) => t.confirmation !== undefined && t !== generate)) expect(needsConfirmation(tool, {}), tool.name).toBe(true);
  });

  it('shows every switch flag an agent may pass as a boolean, so "false" can never switch it on', () => {
    for (const tool of registry.tools) {
      const flags = [...tool.command.flags, ...registry.globalFlags];
      for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
        const flag = flags.find((f) => f.name === name);
        if (flag !== undefined && !flag.takesValue) expect(schema.type, `${tool.name} ${name}`).toBe('boolean');
      }
    }
  });

  it('describes removing a wallet as deleting its file and seed', () => {
    const remove = registry.tools.find((t) => t.name === NEWLY_CONFIRMED)!;
    expect(confirmationText(remove, { name: 'bob' })).toBe('Remove wallet bob: its file, and the seed in it, is deleted from this machine');
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

  // The argv each tool's own handler built before the registry (src/lib/mcp/tools.ts at
  // 03b55c4), for a call with these parameters. The generic mapping must
  // build the same.
  const args = (command: string, subcommand: string | undefined, positionals: string[], flags: Record<string, string | true>): ParsedArgs =>
    ({ command, subcommand, positionals, flags: { json: true, ...flags } });
  const ARGV_BEFORE_REGISTRY: [tool: string, params: Record<string, unknown>, argv: ParsedArgs][] = [
    ['midnight_wallet_generate', { name: 'alice', network: 'preprod', seed: 'ab', force: true }, args('wallet', 'generate', ['alice'], { network: 'preprod', seed: 'ab', force: true })],
    ['midnight_wallet_generate', { name: 'alice', mnemonic: 'w o r d s', force: true }, args('wallet', 'generate', ['alice'], { mnemonic: 'w o r d s', force: true })],
    ['midnight_wallet_list', {}, args('wallet', 'list', [], {})],
    ['midnight_wallet_list', { full: true }, args('wallet', 'list', [], { [FULL_FLAG]: true })],
    ['midnight_wallet_list', { full: false }, args('wallet', 'list', [], {})],
    ['midnight_wallet_use', { name: 'bob' }, args('wallet', 'use', ['bob'], {})],
    ['midnight_wallet_info', {}, args('wallet', 'info', [], {})],
    ['midnight_wallet_info', { name: '', full: true }, args('wallet', 'info', [], { [FULL_FLAG]: true })],
    ['midnight_wallet_info', { name: 'bob' }, args('wallet', 'info', ['bob'], {})],
    // Run once the user has confirmed: --yes, so the CLI asks no second time.
    ['midnight_wallet_remove', { name: 'bob' }, args('wallet', 'remove', ['bob'], { yes: true })],
    ['midnight_info', { wallet: 'alice' }, args('info', undefined, [], { wallet: 'alice' })],
    ['midnight_balance', { address: 'mn_addr_x', network: 'preview', 'indexer-ws': 'ws://i', full: true }, args('balance', 'mn_addr_x', [], { network: 'preview', 'indexer-ws': 'ws://i', [FULL_FLAG]: true })],
    ['midnight_balance', { wallet: 'alice' }, args('balance', undefined, [], { wallet: 'alice' })],
    ['midnight_address', { seed: 'ab', index: '2', network: 'undeployed' }, args('address', undefined, [], { seed: 'ab', index: '2', network: 'undeployed' })],
    ['midnight_genesis_address', { network: 'undeployed' }, args('genesis-address', undefined, [], { network: 'undeployed' })],
    ['midnight_inspect_cost', {}, args('inspect-cost', undefined, [], {})],
    ['midnight_inspect_cost', { network: 'preprod' }, args('inspect-cost', undefined, [], { network: 'preprod' })],
    ['midnight_airdrop', { amount: '10', wallet: 'bob', shielded: true }, args('airdrop', '10', [], { wallet: 'bob', shielded: true })],
    ['midnight_transfer', { to: 'bob', amount: '1', wallet: 'alice', network: 'undeployed' }, args('transfer', 'bob', ['1'], { wallet: 'alice', network: 'undeployed' })],
    ['midnight_transfer', { to: 'bob' }, args('transfer', 'bob', [], {})],
    // Added since the registry: recipients, each a <to> <amount> pair after the command, the first to filling the subcommand slot.
    ['midnight_transfer', { recipients: [{ to: 'bob', amount: '1' }, { to: 'mn_addr_undeployed1x', amount: 2.5 }], wallet: 'alice' }, args('transfer', 'bob', ['1', 'mn_addr_undeployed1x', '2.5'], { wallet: 'alice' })],
    ['midnight_transfer', { recipients: [] }, args('transfer', undefined, [], {})],
    ['midnight_dust_register', { wallet: 'alice' }, args('dust', 'register', [], { wallet: 'alice' })],
    ['midnight_dust_status', { 'no-cache': true, node: 'ws://n', full: true }, args('dust', 'status', [], { 'no-cache': true, node: 'ws://n', [FULL_FLAG]: true })],
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
    ['midnight_swap_make', { give: '10', 'give-token': 'aa', want: '7', 'want-token': 'bb', 'expires-in': '600' }, args('swap', 'make', [], { give: '10', 'give-token': 'aa', want: '7', 'want-token': 'bb', 'expires-in': '600' })],
    ['midnight_swap_inspect', { file: 'offer.json' }, args('swap', 'inspect', ['offer.json'], {})],
    ['midnight_swap_take', { file: 'offer.json', give: '10', 'give-token': 'aa', want: '7', 'want-token': 'bb', wallet: 'bob' }, args('swap', 'take', ['offer.json'], { give: '10', 'give-token': 'aa', want: '7', 'want-token': 'bb', wallet: 'bob' })],
    ['midnight_swap_cancel', { id: '3fa1c0de' }, args('swap', 'cancel', ['3fa1c0de'], {})],
    ['midnight_swap_list', { network: 'undeployed' }, args('swap', 'list', [], { network: 'undeployed' })],
    ['midnight_tx_status', { transaction: 'ab12', wait: true, timeout: '30' }, args('tx', 'status', ['ab12'], { wait: true, timeout: '30' })],
    ['midnight_grant_issue', { link: 'L', 'per-call': '2' }, args('grant', 'issue', ['L'], { 'per-call': '2', yes: true })],
    ['midnight_grant_revoke', { grant: '3' }, args('grant', 'revoke', ['3'], {})],
    ['midnight_grant_revoke_all', {}, args('grant', 'revoke-all', [], {})],
    ['midnight_test_create', { path: './d', 'no-ai': true, force: false, port: '4173' }, args('test', 'create', [], { path: './d', 'no-ai': true, port: '4173' })],
  ];

  it('builds the argv each tool\'s own handler built', () => {
    for (const [name, params, expected] of ARGV_BEFORE_REGISTRY) {
      const tool = registry.tools.find((t) => t.name === name)!;
      expect(toolArgv(tool, params), `${name} ${JSON.stringify(params)}`).toStrictEqual(expected);
    }
    // Every tool is covered.
    expect(new Set(ARGV_BEFORE_REGISTRY.map(([name]) => name))).toStrictEqual(new Set(registry.tools.map((t) => t.name)));
  });
});

