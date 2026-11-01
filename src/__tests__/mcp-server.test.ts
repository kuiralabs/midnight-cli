import { describe, it, expect } from 'vitest';
import { commandHelpSpecs } from '../lib/command-definition.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import { listedTools } from '../lib/mcp/registry-tools.ts';

// Every command an agent can use has an MCP tool: the tools the server lists
// (from the registry) against the commands help lists (from the registry).

const TOOL_NAMES = listedTools(installedCommands).map((tool) => tool.name);

// help/manual are info channels (the skill resource serves agents),
// serve/test/dev are long-running and interactive, generate is deprecated.
const NO_TOOL = new Set(['help', 'manual', 'serve', 'test', 'dev', 'generate']);

const hasTool = (command: string): boolean => {
  const normalized = command.replace('-', '_');
  return TOOL_NAMES.some((t) => t === `midnight_${normalized}` || t.startsWith(`midnight_${normalized}_`));
};

describe('MCP tool coverage', () => {
  it('every CLI command has at least one MCP tool', () => {
    for (const spec of commandHelpSpecs(installedCommands).filter((s) => !NO_TOOL.has(s.name))) {
      expect(hasTool(spec.name), `CLI command "${spec.name}" should have a matching MCP tool`).toBe(true);
    }
  });

  it('every command with JSON fields has a tool', () => {
    const commandsWithJson = commandHelpSpecs(installedCommands).filter((s) => s.jsonFields && !NO_TOOL.has(s.name));
    expect(commandsWithJson.length).toBeGreaterThan(0);
    for (const spec of commandsWithJson) expect(hasTool(spec.name), `${spec.name} should have an MCP tool`).toBe(true);
  });

  it('lists the confirm tool', () => {
    expect(TOOL_NAMES).toContain('midnight_confirm_operation');
  });
});
