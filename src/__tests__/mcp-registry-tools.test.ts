// The MCP server's tools from a registry (src/lib/mcp/registry-tools.ts, plan
// 2E), with test commands whose handlers record the argv they get and write
// their JSON result through their call's context, as a command does.

import { describe, expect, it } from 'vitest';
import { createCommandRegistry, type CommandDefinition, type ToolDefinition } from '../lib/command-definition.ts';
import { CONFIRM_TOOL, confirmationFor, findTool, listedTools, runTool } from '../lib/mcp/registry-tools.ts';
import type { CallContext } from '../lib/call-context.ts';
import { MINIMAL_FLAG, type ParsedArgs } from '../lib/argv.ts';

const received: ParsedArgs[] = [];
const command = (tools: ToolDefinition[]): CommandDefinition => ({
  name: 'thing',
  order: 1,
  subcommands: ['make', 'show'],
  flags: [{ name: 'size', takesValue: true, agent: { type: 'string', description: 'How big' } }, { name: 'go', takesValue: false, subcommands: ['make'], agent: { notForAgents: 'a person\'s' } }],
  needsWalletSdk: false,
  shell: {},
  load: async () => ({
    default: async (args: ParsedArgs, ctx: CallContext) => {
      received.push(structuredClone(args));
      ctx.output.result({ subcommand: args.subcommand, size: args.flags.size ?? null, go: args.flags.go === true });
    },
  }),
  mcp: { tools },
});

const registry = createCommandRegistry([command([
  { name: 'thing_show', description: 'Show.', annotations: { readOnlyHint: true }, params: [], argv: { subcommand: 'show', flags: 'rest' }, order: 2 },
  {
    name: 'thing_make',
    description: 'Make.',
    params: [{ name: 'label', schema: { type: 'string' } }],
    argv: { subcommand: 'make', positionals: ['label'], flags: 'rest', fixedFlags: { go: true } },
    confirmation: {
      async check(params, call) {
        if (params.label === 'bad') throw new Error('not that one');
        const shown = call.argv();
        delete shown.flags.go;
        const result = await call.run({ ...shown, subcommand: 'show' });
        return `Make ${params.label} at size ${result.size}`;
      },
    },
    order: 1,
  },
  { name: 'thing_plain', description: 'Plain.', params: [], argv: { subcommand: 'show', flags: [] }, confirmation: { describe: () => 'Plain thing' }, order: 3 },
])], []);

describe('the MCP server\'s tools from a registry', () => {
  it('lists them in the registry\'s order, with their generated schemas, then the confirm tool', () => {
    expect(listedTools(registry)).toStrictEqual([
      { name: 'thing_make', description: 'Make.', inputSchema: { type: 'object', properties: { label: { type: 'string' }, size: { type: 'string', description: 'How big' } } } },
      { name: 'thing_show', description: 'Show.', inputSchema: { type: 'object', properties: { size: { type: 'string', description: 'How big' } } }, annotations: { readOnlyHint: true } },
      { name: 'thing_plain', description: 'Plain.', inputSchema: { type: 'object', properties: {} } },
      CONFIRM_TOOL,
    ]);
    expect(findTool(registry, CONFIRM_TOOL.name)).toBeUndefined();
  });

  it('runs a tool\'s command with the argv its parameters map to, in agent mode, and returns its result', async () => {
    received.length = 0;
    const result = await runTool(findTool(registry, 'thing_make')!, { label: 'cup', size: '3' }, {});
    expect(result).toStrictEqual({ subcommand: 'make', size: '3', go: true });
    expect(received).toStrictEqual([{ command: 'thing', subcommand: 'make', positionals: ['cup'], flags: { json: true, size: '3', go: true, [MINIMAL_FLAG]: true } }]);
  });

  it('confirms the text a check finds, after running what the check asks, and lets a check refuse', async () => {
    received.length = 0;
    expect(await confirmationFor(findTool(registry, 'thing_make')!, { label: 'cup', size: '3' }, {})).toBe('Make cup at size 3');
    // The check ran the command once, without the flag the tool fixes.
    expect(received.map((args) => [args.subcommand, args.flags.go])).toStrictEqual([['show', undefined]]);
    await expect(confirmationFor(findTool(registry, 'thing_make')!, { label: 'bad' }, {})).rejects.toThrow('not that one');
  });

  it('confirms the definition\'s text when there is no check', async () => {
    expect(await confirmationFor(findTool(registry, 'thing_plain')!, {}, {})).toBe('Plain thing');
  });
});
