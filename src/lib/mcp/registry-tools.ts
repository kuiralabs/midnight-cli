// The MCP server's tools, from the command registry (plan 2E): each command's
// definition gives its tools' names, descriptions, annotations, schemas, argv
// mapping and confirmation; the server runs the command's own handler. The
// server's one tool of its own, midnight_confirm_operation, redeems the tokens
// the confirmation flow gives.

import { type CommandRun, captureCommand } from '../run-command.ts';
import {
  type CommandRegistry,
  type RegisteredTool,
  type ToolAnnotations,
  type ToolInputSchema,
  confirmationText,
  toolArgv,
} from '../command-definition.ts';

/** A tool as tools/list sends it. */
export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly annotations?: ToolAnnotations;
}

/** The server's own tool: the confirm step, which redeems a pending token. */
export const CONFIRM_TOOL: ListedTool = {
  name: 'midnight_confirm_operation',
  description: 'Redeem a pending token (confirm step).',
  inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
  annotations: { destructiveHint: true, openWorldHint: true },
};

/** tools/list: every tool the installed commands define, in the registry's order, then the confirm tool. */
export function listedTools(registry: CommandRegistry): ListedTool[] {
  return [...registry.tools, CONFIRM_TOOL].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }));
}

/** The command's tool by that name, if one defines it. */
export function findTool(registry: CommandRegistry, name: string): RegisteredTool | undefined {
  return registry.tools.find((tool) => tool.name === name);
}

/** Runs the tool's command with the argv its parameters map to, and returns its JSON result. */
export async function runTool(tool: RegisteredTool, params: Readonly<Record<string, unknown>>, call: CommandRun): Promise<Record<string, unknown>> {
  return captureCommand((await tool.command.load()).default, toolArgv(tool, params), call);
}

/**
 * For a tool behind confirmation: runs its check, which throws when the call
 * can't run, and returns the text the user confirms (the check's own, or the
 * definition's from the parameters).
 */
export async function confirmationFor(tool: RegisteredTool, params: Readonly<Record<string, unknown>>, call: CommandRun): Promise<string> {
  const found = await tool.confirmation?.check?.(params, {
    argv: () => toolArgv(tool, params),
    run: async (args) => captureCommand((await tool.command.load()).default, args, call),
  });
  return found ?? confirmationText(tool, params);
}
