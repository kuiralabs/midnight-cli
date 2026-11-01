// The command registry (plan 2B): every command defined once, beside it. Until
// 2C–2E switch them over, dispatch, help, the intro and the MCP server keep
// their own lists; each test here rebuilds one of those lists from the
// registry and requires it to equal the list as it is, so the switch can't
// change what a user or an agent sees. Where the lists disagree today, the
// definitions record what each says (Y29 fixes them later).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { installedCommands } from '../lib/installed-commands.ts';
import {
  CommandDefinitionError,
  confirmationText,
  createCommandRegistry,
  flagsSectionLines,
  type CommandDefinition,
} from '../lib/command-definition.ts';
import { COMMAND_FLAGS, GLOBAL_FLAGS } from '../lib/command-flags.ts';
import { COMMAND_SPECS, type CommandSpec } from '../commands/help.ts';
import { COMMAND_BRIEFS } from '../ui/art.ts';
import { TOOLS, REQUIRES_CONFIRMATION, describePendingOp, handlerLoaders } from '../lib/mcp/tools.ts';

const SRC = join(import.meta.dirname, '..');
const registry = installedCommands;

/** A single-quoted TypeScript string literal's value. */
function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

describe('the dispatch (src/wallet.ts)', () => {
  // The dispatch is a switch, not a list, and wallet.ts runs the CLI when
  // imported; so its cases are read from the source, every one accounted for.
  const source = readFileSync(join(SRC, 'wallet.ts'), 'utf8');
  const body = source.slice(source.indexOf('switch (command) {'), source.indexOf('    default:'));
  const cases = body.split(/\n    case /).slice(1).map((block) => {
    const name = block.match(/^'([a-z-]+)'/)?.[1];
    const loads = block.match(/import\('\.\/commands\/([a-z-]+)\.ts'\)/)?.[1];
    const thrown = block.match(/throw new Error\(('(?:[^'\\]|\\.)*')\)/)?.[1];
    const notice = block.match(/process\.stderr\.write\(([^;]*)\);/)?.[1];
    return {
      name,
      loads,
      signal: /handler\(args, signal\b/.test(block),
      payer: /\{ payer: servePayer \}/.test(block),
      protectors: /\{ protectors: \[accountProtector\] \}/.test(block),
      notice: notice === undefined ? undefined : [...notice.matchAll(/'(?:[^'\\]|\\.)*'/g)].map((m) => unquote(m[0])).join(''),
      unavailable: thrown === undefined ? undefined : unquote(thrown),
    };
  });

  it('reads every case: each loads its own command or refuses it', () => {
    expect(cases.length).toBe(21);
    for (const c of cases) {
      expect(c.name).toBeDefined();
      expect(c.loads === c.name || (c.loads === undefined && c.unavailable !== undefined), String(c.name)).toBe(true);
    }
  });

  it('is rebuilt exactly: its commands and what the shell gives each', () => {
    const today = cases.map(({ loads: _loads, ...c }) => c).sort((a, b) => a.name!.localeCompare(b.name!));
    const rebuilt = registry.commands.map((c) => ({
      name: c.name,
      signal: c.shell.signal === true,
      payer: c.shell.payer === true,
      protectors: c.shell.protectors === true,
      notice: c.shell.notice,
      unavailable: c.shell.unavailable,
    })).sort((a, b) => a.name.localeCompare(b.name));
    expect(rebuilt).toStrictEqual(today);
  });

  it('loads each handler from the module the dispatch imports', async () => {
    for (const c of cases.filter((c) => c.loads !== undefined)) {
      const fromDispatch = await import(`../commands/${c.loads}.ts`);
      const fromRegistry = await registry.find(c.name!)!.load();
      expect(fromRegistry.default, c.name).toBe(fromDispatch.default);
    }
  }, 120_000);
});

describe('the commands that need the wallet SDK (FACADE_COMMANDS in src/wallet.ts)', () => {
  it('is rebuilt exactly', () => {
    const source = readFileSync(join(SRC, 'wallet.ts'), 'utf8');
    const listed = source.match(/const FACADE_COMMANDS = new Set\(\[([^\]]*)\]\)/)![1]!;
    const today = [...listed.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    const rebuilt = registry.commands.filter((c) => c.needsWalletSdk).map((c) => c.name);
    expect(new Set(rebuilt)).toStrictEqual(new Set(today));
    expect(rebuilt).toHaveLength(today.length);
  });
});

describe('the accepted flags (COMMAND_FLAGS and GLOBAL_FLAGS)', () => {
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
