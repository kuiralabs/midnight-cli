// The MCP server's tools, from the command registry: each command's
// definition gives its tools' names, descriptions (ending with the codes its
// command can end with), annotations, schemas, argv mapping and confirmation; the
// server runs the command's own handler. The
// server's one tool of its own, midnight_confirm_operation, redeems the tokens
// the confirmation flow gives.

import { type CommandRun, captureCommand } from '../run-command.ts';
import { listedNames } from '../code-tables.ts';
import { getEndpointOverridesForNetwork, loadCliConfig } from '@kuiralabs/midnight-cli-core/lib/cli-config';
import { resolveNetworkName } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import {
  type CommandRegistry,
  type RegisteredTool,
  type ToolAnnotations,
  type ToolInputSchema,
  commandOwnCodes,
  confirmationText,
  declaredSets,
  toolArgv,
} from '@kuiralabs/midnight-cli-core/lib/command-definition';

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

/**
 * A command's tool's description as tools/list sends it: its definition's,
 * then the codes its command can end with: its own, and the sets it declares
 * by name, which the full skill lists.
 */
export function toolDescription(registry: Pick<CommandRegistry, 'code'>, tool: RegisteredTool): string {
  const own = commandOwnCodes(registry, tool.command).map((definition) => definition.code);
  const sets = declaredSets(tool.command).map((set) => set.name);
  if (own.length === 0 && sets.length === 0) return tool.description;
  const named = sets.length === 0 ? '' : `the ${listedNames(sets)} codes (see the skill)`;
  return `${tool.description} Errors: ${own.join(', ')}${own.length > 0 && named !== '' ? '; and ' : ''}${named}.`;
}

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

/** Runs the tool's command with the argv its parameters map to, and returns its JSON result. */
export async function runTool(tool: RegisteredTool, params: Readonly<Record<string, unknown>>, call: CommandRun): Promise<Record<string, unknown>> {
  return captureCommand((await tool.command.load()).default, toolArgv(tool, params), call);
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
    run: async (args) => captureCommand((await tool.command.load()).default, args, call),
  });
  return (found ?? confirmationText(tool, params)) + endpointOverridesNote(tool, params, call.host.paths().stateRoot);
}
