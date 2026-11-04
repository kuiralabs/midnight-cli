// A command registry made from definitions: the Flags section help renders,
// and the definitions it refuses (a command or a flag defined twice, a tool
// that doesn't fit its command).

import { describe, expect, it } from 'vitest';
import { CommandDefinitionError, createCommandRegistry, flagsSectionLines, type CommandDefinition, type ToolDefinition } from '../lib/command-definition.ts';

describe('createCommandRegistry', () => {
  const base: CommandDefinition = {
    name: 'x',
    order: 1,
    flags: [{ name: 'a', takesValue: false, help: ['--a   A'] }],
    help: { description: 'X', usage: 'midnight x', flags: ['note', { flag: 'a' }] },
    needsWalletSdk: false,
    shell: {},
    errors: { codes: [] },
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
