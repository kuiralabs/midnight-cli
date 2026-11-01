// The MCP server's one check on a call's parameters: a parameter outside the
// tool's schema is refused before anything runs.

import { UsageError } from '../errors.ts';

/** A tool's name and the schema of the parameters it takes. */
interface ToolSchema {
  readonly name: string;
  readonly inputSchema: { readonly properties: Readonly<Record<string, unknown>> };
}

/** The parameters a call gives that are not in the tool's schema, in the order given. */
export function findUnknownParams(tool: ToolSchema, params: Record<string, unknown>): string[] {
  return Object.keys(params).filter((key) => !Object.hasOwn(tool.inputSchema.properties, key));
}

/**
 * Throw a UsageError (INVALID_ARGS) naming every parameter outside the tool's
 * schema (Y29). Each parameter used to become a flag unchecked, so a misspelt
 * one was dropped and the command ran on its defaults; the CLI refuses an
 * unknown flag the same way. Since 2E the schema lists every parameter a tool
 * takes, its command's flags among them, so it is the one check (2C also let
 * through any flag of the command).
 */
export function assertKnownParams(tool: ToolSchema, params: Record<string, unknown>): void {
  const unknown = findUnknownParams(tool, params);
  if (unknown.length === 0) return;
  const accepted = Object.keys(tool.inputSchema.properties);
  const takes = accepted.length === 0 ? 'It takes no parameters' : `Its parameters: ${accepted.join(', ')}`;
  throw new UsageError(`Unknown parameter${unknown.length > 1 ? 's' : ''} for ${tool.name}: ${unknown.join(', ')}\n${takes}`);
}
