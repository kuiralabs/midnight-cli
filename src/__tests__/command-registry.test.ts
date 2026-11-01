// The command registry (plan 2B): every command defined once, beside it.
// Since 2C the CLI's dispatch, its SDK commands and its accepted flags come
// from it; their tests pin what the lists they replaced said. Until 2D–2E
// switch them over, help, the intro and the MCP server keep their own lists;
// each test here rebuilds one of those lists from the registry and requires it
// to equal the list as it is, so the switch can't change what a user or an
// agent sees. Where the lists disagree today, the definitions record what each
// says (Y29 fixes them later).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { installedCommands } from '../lib/installed-commands.ts';
import {
  CommandDefinitionError,
  confirmationText,
  createCommandRegistry,
  flagsSectionLines,
  toolPassThroughFlags,
  type CommandDefinition,
} from '../lib/command-definition.ts';
import { COMMAND_FLAGS, GLOBAL_FLAGS } from '../lib/command-flags.ts';
import { commandNeedsWalletSdk, dispatchCommand, type ShellProvisions } from '../lib/command-dispatch.ts';
import { parseArgs, type ParsedArgs } from '../lib/argv.ts';
import { isUsageError } from '../lib/errors.ts';
import type { Payer } from '../lib/payer.ts';
import type { WalletProtector } from '../lib/wallet-protector.ts';
import { COMMAND_SPECS, type CommandSpec } from '../commands/help.ts';
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

describe('help\'s command specs (COMMAND_SPECS in src/commands/help.ts)', () => {
  function rebuildSpec(c: CommandDefinition & { help: NonNullable<CommandDefinition['help']> }): CommandSpec {
    return {
      name: c.name,
      description: c.help.description,
      usage: c.help.usage,
      ...(c.help.flags === undefined ? {} : { flags: flagsSectionLines(c) }),
      ...(c.help.examples === undefined ? {} : { examples: [...c.help.examples] }),
      ...(c.help.jsonFields === undefined ? {} : { jsonFields: { ...c.help.jsonFields } }),
    };
  }
  const rebuilt = registry.commands
    .filter((c): c is CommandDefinition & { help: NonNullable<CommandDefinition['help']> } => c.help !== undefined)
    .map(rebuildSpec);

  it('is rebuilt exactly, in its order', () => {
    expect(rebuilt).toStrictEqual(COMMAND_SPECS);
  });

  it('is rebuilt byte for byte as help --json and the manual read it', () => {
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(COMMAND_SPECS));
  });
});

describe('the intro\'s briefs (COMMAND_BRIEFS in src/ui/art.ts)', () => {
  it('is rebuilt exactly, in its order', () => {
    const rebuilt = registry.commands
      .flatMap((c) => (c.intro === undefined ? [] : [{ order: c.intro.order, entry: [c.name, c.intro.brief] }]))
      .sort((a, b) => a.order - b.order)
      .map(({ entry }) => entry);
    expect(rebuilt).toStrictEqual(COMMAND_BRIEFS);
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

describe('the MCP tools (TOOLS in src/lib/mcp/tools.ts)', () => {
  // What tools/list sends for a tool, built as the server builds it.
  const listed = (t: { name: string; description: string; inputSchema: unknown; annotations?: unknown }) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  });

  it('is rebuilt byte for byte as tools/list sends it, in its order, before the server\'s own confirm tool', () => {
    // midnight_confirm_operation belongs to no command: the server redeems tokens with it.
    expect(TOOLS.at(-1)!.name).toBe('midnight_confirm_operation');
    const today = TOOLS.slice(0, -1).map(listed);
    const rebuilt = registry.tools.map(listed);
    expect(JSON.stringify(rebuilt, null, 2)).toBe(JSON.stringify(today, null, 2));
    expect(rebuilt).toStrictEqual(today);
  });

  it('needs confirmation for the same tools', () => {
    const rebuilt = new Set(registry.tools.filter((t) => t.confirmation !== undefined).map((t) => t.name));
    expect(rebuilt).toStrictEqual(REQUIRES_CONFIRMATION);
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

  it('lets a tool pass on its command\'s flags beyond its schema only when its argv passes the rest on', () => {
    // midnight_transfer passes the rest on as flags: transfer's flags and the global ones.
    expect(toolPassThroughFlags(registry, 'midnight_transfer')).toStrictEqual([
      ...registry.find('transfer')!.flags.map((f) => f.name), 'help', 'h', 'json', 'version', 'v',
    ]);
    // midnight_config_get maps only its own parameters.
    expect(toolPassThroughFlags(registry, 'midnight_config_get')).toStrictEqual([]);
    // The server's own confirm tool belongs to no command.
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

  it('refuses two tools with one name or one place', () => {
    const tool = { name: 't', description: 'T', inputSchema: { type: 'object' as const, properties: {} }, argv: { flags: 'rest' as const }, order: 1 };
    expect(() => createCommandRegistry([{ ...base, mcp: { tools: [tool, tool] } }], [])).toThrow(/MCP tool "t"/);
    expect(() => createCommandRegistry([{ ...base, mcp: { tools: [tool, { ...tool, name: 'u' }] } }], [])).toThrow(/place "1"/);
  });
});
