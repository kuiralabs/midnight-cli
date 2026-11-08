// The MCP server's checks on a call's parameters, before anything runs: a
// parameter outside the tool's schema is refused, and so is one whose value
// is not the type its schema says.

import { UsageError } from '@kuiralabs/midnight-cli-core';

/** A parameter's schema as the server checks it. */
interface ParamCheck {
  readonly type: string;
  readonly enum?: readonly string[];
  /** With type 'array': each item, an object of the fields it lists. */
  readonly items?: { readonly properties: Readonly<Record<string, ParamCheck>>; readonly required?: readonly string[] };
}

/** A tool's name and the schema of the parameters it takes. */
interface ToolSchema {
  readonly name: string;
  readonly inputSchema: { readonly properties: Readonly<Record<string, ParamCheck>> };
}

/** The parameters a call gives that are not in the tool's schema, in the order given. */
export function findUnknownParams(tool: ToolSchema, params: Record<string, unknown>): string[] {
  return Object.keys(params).filter((key) => !Object.hasOwn(tool.inputSchema.properties, key));
}

/**
 * Throw a UsageError (INVALID_ARGS) naming every parameter outside the tool's
 * schema. Each parameter used to become a flag unchecked, so a misspelt one
 * was dropped and the command ran on its defaults; the CLI refuses an unknown
 * flag the same way. The schema lists every parameter a tool takes, its
 * command's flags among them, so it is the one check.
 */
export function assertKnownParams(tool: ToolSchema, params: Record<string, unknown>): void {
  const unknown = findUnknownParams(tool, params);
  if (unknown.length === 0) return;
  const accepted = Object.keys(tool.inputSchema.properties);
  const takes = accepted.length === 0 ? 'It takes no parameters' : `Its parameters: ${accepted.join(', ')}`;
  throw new UsageError(`Unknown parameter${unknown.length > 1 ? 's' : ''} for ${tool.name}: ${unknown.join(', ')}\n${takes}`);
}

/** Why the value doesn't fit the schema, or undefined when it does. Absent (undefined or null) always fits. */
function mistyped(schema: ParamCheck, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (schema.type === 'boolean') {
    return typeof value === 'boolean' ? undefined : `must be true or false, not ${JSON.stringify(value)}`;
  }
  if (schema.type === 'array') return mistypedArray(schema, value);
  // A string parameter takes a number as its digits (an amount, a port): nothing is misread.
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
    return `must be a string, not ${JSON.stringify(value)}`;
  }
  if (schema.enum !== undefined && !schema.enum.includes(String(value))) {
    return `must be one of ${schema.enum.join(', ')}, not ${JSON.stringify(value)}`;
  }
  return undefined;
}

/** Why the value isn't an array of the items the schema says, naming the first item that isn't; undefined when it is. */
function mistypedArray(schema: ParamCheck, value: unknown): string | undefined {
  if (!Array.isArray(value)) return `must be an array, not ${JSON.stringify(value)}`;
  const fields = schema.items?.properties ?? {};
  for (const [index, item] of value.entries()) {
    const where = `item ${index + 1}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return `${where} must be an object, not ${JSON.stringify(item)}`;
    const record = item as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => !Object.hasOwn(fields, key));
    if (unknown.length > 0) return `${where} has ${unknown.join(', ')}, which it doesn't take (its fields: ${Object.keys(fields).join(', ')})`;
    const missing = (schema.items?.required ?? []).filter((key) => record[key] === undefined || record[key] === null || record[key] === '');
    if (missing.length > 0) return `${where} has no ${missing.join(', ')}`;
    for (const [key, field] of Object.entries(fields)) {
      const why = mistyped(field, record[key]);
      if (why !== undefined) return `${where}: ${key} ${why}`;
    }
  }
  return undefined;
}

/**
 * Throw a UsageError (INVALID_ARGS) naming every known parameter whose value
 * is not its schema's type. An on/off parameter must be a boolean: the
 * string "false" used to switch it on, since any value but `false` set the
 * flag.
 */
export function assertParamTypes(tool: ToolSchema, params: Record<string, unknown>): void {
  const problems = Object.entries(params).flatMap(([key, value]) => {
    const schema = tool.inputSchema.properties[key];
    const why = schema === undefined ? undefined : mistyped(schema, value);
    return why === undefined ? [] : [`${key} ${why}`];
  });
  if (problems.length === 0) return;
  throw new UsageError(`Invalid parameter${problems.length > 1 ? 's' : ''} for ${tool.name}: ${problems.join('; ')}`);
}
