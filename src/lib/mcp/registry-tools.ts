// The MCP server's tools, from the command registry: each command's
// definition gives its tools' names, descriptions (ending with the codes its
// command can end with), annotations, schemas, argv mapping and confirmation; the
// server runs the command's own handler. The
// server's one tool of its own, midnight_confirm_operation, redeems the tokens
// the confirmation flow gives.

import { captureCommand, type CommandRun, getEndpointOverridesForNetwork, loadCliConfig, resolveNetworkName, type CommandRegistry, type ParsedArgs, type RegisteredTool, type ToolAnnotations, type ToolInputSchema, confirmationText, toolArgv, toolDescription } from '@kuiralabs/midnight-cli-core';

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
  return [...registry.tools.map((tool) => ({ ...tool, description: toolDescription(registry, tool) })), CONFIRM_TOOL].map((tool) => ({
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

/** The server's stderr: where a call's text for the person goes, never the protocol channel on stdout. */
const serverStderr = (text: string): void => { process.stderr.write(text); };

/** Runs the tool's command with `args` (core's `captureCommand`), its text on the server's stderr, and returns its JSON result. */
function captureTool(tool: RegisteredTool, args: ParsedArgs, call: CommandRun): Promise<Record<string, unknown>> {
  return captureCommand(tool.command, args, { ...call, text: serverStderr });
}

/** Runs the tool's command with the argv its parameters map to, and returns its JSON result. */
export async function runTool(tool: RegisteredTool, params: Readonly<Record<string, unknown>>, call: CommandRun): Promise<Record<string, unknown>> {
  return captureTool(tool, toolArgv(tool, params), call);
}

/** The endpoint parameters, and how a confirmation names each. */
const ENDPOINTS = [['node', 'node'], ['indexer-ws', 'indexer'], ['proof-server', 'proof server']] as const;

/**
 * The endpoints the call is sent to other than the network's own, for the
 * text the user confirms: each given as a parameter, or else set for the
 * network with `config set`. Empty when the tool takes no endpoints or none
 * is overridden. Without it, a transaction's proof could go to a host the
 * user never saw. The saved endpoints are the config's under the state root
 * `root`.
 */
export function endpointOverridesNote(tool: RegisteredTool, params: Readonly<Record<string, unknown>>, root: string): string {
  const properties = tool.inputSchema.properties;
  if (!ENDPOINTS.some(([param]) => Object.hasOwn(properties, param))) return '';
  const configured = getEndpointOverridesForNetwork(loadCliConfig(root), resolveNetworkName({ args: toolArgv(tool, params), configDir: root }));
  const named = ENDPOINTS.flatMap(([param, label]) => {
    const given = params[param];
    if (typeof given === 'string' && given !== '') return [`${label} ${given}`];
    const set = configured[param];
    return set === undefined ? [] : [`${label} ${set} (set with config)`];
  });
  return named.length === 0 ? '' : `. Endpoints: ${named.join(', ')}`;
}

/**
 * For a tool behind confirmation: runs its check, which throws when the call
 * can't run, and returns the text the user confirms (the check's own, or the
 * definition's from the parameters), naming any endpoint the call is sent to
 * other than the network's own.
 */
export async function confirmationFor(tool: RegisteredTool, params: Readonly<Record<string, unknown>>, call: CommandRun): Promise<string> {
  const found = await tool.confirmation?.check?.(params, {
    host: call.host,
    argv: () => toolArgv(tool, params),
    run: async (args) => captureTool(tool, args, call),
  });
  return (found ?? confirmationText(tool, params)) + endpointOverridesNote(tool, params, call.host.paths().stateRoot);
}
