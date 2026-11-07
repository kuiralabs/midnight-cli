// The MCP server's tools from a registry (src/lib/mcp/registry-tools.ts),
// with test commands whose handlers record the argv they get and write
// their JSON result through their call's context, as a command does; and the
// installed tools' descriptions.

import { describe, expect, it } from 'vitest';
import { createCommandRegistry, type CommandDefinition, type ToolDefinition, type CallContext, MINIMAL_FLAG, type ParsedArgs } from '@kuiralabs/midnight-cli-core';
import { installedCommands } from '../lib/installed-commands.ts';
import { CONFIRM_TOOL, confirmationFor, findTool, listedTools, pinConfirmedTarget, runTool } from '../lib/mcp/registry-tools.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ownCall } from './helpers/own-call.ts';

const received: ParsedArgs[] = [];
const command = (tools: ToolDefinition[]): CommandDefinition => ({
  name: 'thing',
  order: 1,
  subcommands: ['make', 'show'],
  flags: [{ name: 'size', takesValue: true, agent: { type: 'string', description: 'How big' } }, { name: 'go', takesValue: false, subcommands: ['make'], agent: { notForAgents: 'a person\'s' } }],
  needsWalletSdk: false,
  shell: {},
  errors: { codes: [] },
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
    const result = await runTool(findTool(registry, 'thing_make')!, { label: 'cup', size: '3' }, ownCall());
    expect(result).toStrictEqual({ subcommand: 'make', size: '3', go: true });
    expect(received).toStrictEqual([{ command: 'thing', subcommand: 'make', positionals: ['cup'], flags: { json: true, size: '3', go: true, [MINIMAL_FLAG]: true } }]);
  });

  it('confirms the text a check finds, after running what the check asks, and lets a check refuse', async () => {
    received.length = 0;
    expect(await confirmationFor(findTool(registry, 'thing_make')!, { label: 'cup', size: '3' }, ownCall())).toBe('Make cup at size 3');
    // The check ran the command once, without the flag the tool fixes.
    expect(received.map((args) => [args.subcommand, args.flags.go])).toStrictEqual([['show', undefined]]);
    await expect(confirmationFor(findTool(registry, 'thing_make')!, { label: 'bad' }, ownCall())).rejects.toThrow('not that one');
  });

  it('confirms the definition\'s text when there is no check', async () => {
    expect(await confirmationFor(findTool(registry, 'thing_plain')!, {}, ownCall())).toBe('Plain thing');
  });
});

describe('pinConfirmedTarget', () => {
  const withConfig = (config: Record<string, unknown> | undefined, test: (root: string) => void): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-pin-'));
    try {
      if (config !== undefined) fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
      test(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const transfer = findTool(installedCommands, 'midnight_transfer')!;

  it('fills in the active wallet and the saved network, as they are when the call is asked', () => {
    withConfig({ wallet: 'alice', network: 'preview' }, (root) => {
      expect(pinConfirmedTarget(transfer, { to: 'bob', amount: '1' }, root)).toStrictEqual({ to: 'bob', amount: '1', wallet: 'alice', network: 'preview' });
    });
  });

  it('keeps the wallet and network the call names', () => {
    withConfig({ wallet: 'alice', network: 'preview' }, (root) => {
      expect(pinConfirmedTarget(transfer, { to: 'bob', amount: '1', wallet: 'carol', network: 'undeployed' }, root)).toStrictEqual({ to: 'bob', amount: '1', wallet: 'carol', network: 'undeployed' });
    });
  });

  it('pins the default wallet and network when none is saved', () => {
    withConfig(undefined, (root) => {
      expect(pinConfirmedTarget(transfer, { to: 'bob', amount: '1' }, root)).toStrictEqual({ to: 'bob', amount: '1', wallet: 'default', network: 'undeployed' });
    });
  });

  it('leaves a tool that acts on no wallet as it was called', () => {
    withConfig({ wallet: 'alice' }, (root) => {
      expect(pinConfirmedTarget(findTool(installedCommands, 'midnight_wallet_remove')!, { name: 'bob' }, root)).toStrictEqual({ name: 'bob' });
    });
  });
});

describe("the installed tools' descriptions", () => {
  it("end with their command's own codes, then its sets of codes by name", () => {
    const description = (name: string): string => listedTools(installedCommands).find((tool) => tool.name === name)!.description;
    const own = (name: string): string => findTool(installedCommands, name)!.description;
    expect(description('midnight_tx_status')).toBe(`${own('midnight_tx_status')} Errors: NETWORK_ERROR, SYNC_TIMEOUT; and the network codes (see the skill).`);
    expect(description('midnight_config_get')).toBe(`${own('midnight_config_get')} Errors: the network codes (see the skill).`);
    expect(description('midnight_transfer')).toBe(`${own('midnight_transfer')} Errors: CHAIN_CLOCK_BEHIND; and the network, wallet, engine, sync, paying, offers and chain codes (see the skill).`);
    // Every installed tool says what it can fail with in at most 20 words.
    for (const tool of listedTools(installedCommands).slice(0, -1)) {
      expect(tool.description.split(' Errors: ')[1]!.split(/\s+/).length + 1, tool.name).toBeLessThanOrEqual(20);
    }
    // The server's own confirm tool runs no command: its description stays as it is.
    expect(listedTools(installedCommands).at(-1)).toStrictEqual(CONFIRM_TOOL);
  });
});
