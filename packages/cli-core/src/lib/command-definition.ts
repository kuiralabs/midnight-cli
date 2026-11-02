// One command, described once: its subcommands, flags, help, the intro's
// line, whether it needs the wallet SDK, what the shell passes its handler,
// its handler, and its MCP tools. Plain data and a lazily loaded handler,
// tied to no CLI framework. Each command's definition sits beside it
// (src/commands/<name>.definition.ts) and must not load the handler's module
// until asked, so reading the registry loads no SDK.
//
// The shell's dispatch and flag checks, help, the manual, the intro and the
// MCP server's tools all read the registry; each tool's schema is generated
// from what it takes and its command's flags. A package is installed with its
// commands and its agent guidance.

import { getValidNetworkNames } from './network.ts';
import { FULL_FLAG, type ParsedArgs } from './argv.ts';
import { type PackageGuidance, type ToolsTableRow, assertDistinctPlaces } from './agent-guidance.ts';
import type { CallContext, CommandOutcome } from './call-context.ts';

/** A parameter as an MCP tool's schema shows it to an agent. */
export interface ParamSchema {
  readonly type: 'string' | 'boolean';
  readonly enum?: readonly string[];
  readonly description?: string;
}

/** A network as tools show it: one of the networks mn knows (a test keeps it equal to network.ts's). */
export const NETWORK_PARAM: ParamSchema = { type: 'string', enum: [...getValidNetworkNames()] };

/** The endpoint flags, as the tools that used to take them unseen describe them. */
export const ENDPOINT_PARAMS = {
  node: { type: 'string', description: 'Node RPC URL (default: the configured one, or the network\'s)' },
  'indexer-ws': { type: 'string', description: 'Indexer WebSocket URL (default: the configured one, or the network\'s)' },
  'proof-server': { type: 'string', description: 'Proof server URL (default: the configured one, or the network\'s)' },
} as const satisfies Readonly<Record<string, ParamSchema>>;

/** A flag agents never pass, and why: it only makes sense at a terminal, the server sets it, or nothing reads it. */
export interface NotForAgents {
  readonly notForAgents: string;
}

/** A flag a command accepts. */
export interface FlagDefinition {
  /** As typed after `--` (or `-`, for one letter). */
  readonly name: string;
  /** `--name <value>`, read as a string; otherwise a bare switch. */
  readonly takesValue: boolean;
  /** The subcommands whose handler reads it; absent: all of them. */
  readonly subcommands?: readonly string[];
  /** Its lines in `help <command>`'s Flags section, exactly as shown; absent: help doesn't list it. */
  readonly help?: readonly string[];
  /**
   * How an MCP tool shows it to an agent, or why agents never pass it. Every
   * flag a tool of its command could pass on says one or the other (the
   * registry refuses a definition where one doesn't); absent: no tool takes it.
   */
  readonly agent?: ParamSchema | NotForAgents;
}

/** One entry of the Flags section of `help <command>`: a line as shown, or a flag's own help lines. */
export type FlagsSectionEntry = string | { readonly flag: string };

/** What `help <command>`, `help --json` and `manual` say about a command. */
export interface CommandHelp {
  readonly description: string;
  readonly usage: string;
  /** The Flags section: subcommands, flags and notes, in the order shown. */
  readonly flags?: readonly FlagsSectionEntry[];
  readonly examples?: readonly string[];
  /** The fields of its `--json` output, with what each holds. */
  readonly jsonFields?: Readonly<Record<string, string>>;
}

/** What the shell does for a command around its handler. Every handler gets its call's signal. */
export interface ShellCall {
  /** The handler gets the shell's payer, the served wallet. */
  readonly payer?: true;
  /** The handler gets the protectors other packages provide (wallet protect). */
  readonly protectors?: true;
  /** Written to stderr before the handler runs. */
  readonly notice?: string;
  /** The shell refuses the command with this message instead of loading it. */
  readonly unavailable?: string;
}

/**
 * A command's module: its handler takes the call's context and may return
 * its exit code. Method syntax, so a handler may narrow the protectors it is
 * given (wallet protect's are the wallet package's).
 */
export interface CommandModule {
  default(args: ParsedArgs, ctx: CallContext): Promise<CommandOutcome | void>;
}

/** The MCP tool annotations the server sends. */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** A tool's input schema, as tools/list sends it: generated from the tool's params and its command's flags. */
export interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ParamSchema>>;
  readonly required?: readonly string[];
}

/**
 * One parameter of a tool, in its schema's order: one of its own (filling the
 * subcommand slot or a positional, or `full`), or one of its command's flags
 * placed there. A flag shows as its definition's `agent` says, unless the tool
 * gives `schema`: how this tool showed it before schemas were generated,
 * kept so tools/list reads the same.
 */
export type ToolParam =
  | { readonly name: string; readonly schema: ParamSchema }
  | { readonly flag: string; readonly schema?: ParamSchema };

/**
 * How a tool's parameters become the command's argv. `--json` is always set,
 * and a `full` parameter becomes the internal full-output flag.
 */
export interface ToolArgv {
  /** The subcommand slot: a fixed subcommand, or the parameter whose value fills it (an empty one leaves it unset). */
  readonly subcommand?: string | { readonly param: string };
  /** Parameters that become positionals, in order, up to the first not given (or empty); each as its string. */
  readonly positionals?: readonly string[];
  /**
   * The parameters that become flags: 'rest' is every other one (one not
   * given is left out, `true` is a bare flag and `false` none, anything else
   * its string), and the tool's schema shows every flag of its command an
   * agent may pass that applies to its subcommand; a list is only those, each
   * when given a truthy value, and the schema shows only those.
   */
  readonly flags: 'rest' | readonly string[];
  /** Flags always set. */
  readonly fixedFlags?: Readonly<Record<string, true>>;
  /** Flag values used when the parameter is not given (or empty). */
  readonly defaultFlags?: Readonly<Record<string, string>>;
}

/** What a tool's check gets besides the call's parameters. */
export interface ToolCheckCall {
  /** The command's argv for the call, as the tool would run it; a fresh copy each time. */
  argv(): ParsedArgs;
  /** Runs the tool's command with `args`, as the tool runs it (same cancellation), and returns its JSON result. */
  run(args: ParsedArgs): Promise<Record<string, unknown>>;
}

/** A tool behind the two-step confirmation. */
export interface ToolConfirmation {
  /** Whether this call needs confirming; absent: every call does. */
  readonly when?: (params: Readonly<Record<string, unknown>>) => boolean;
  /** The text the user confirms, from the tool's parameters; absent: the check works it out. */
  readonly describe?: (params: Readonly<Record<string, unknown>>) => string;
  /**
   * Checks the call before a token is issued, throwing what the command would,
   * so the user is never asked to confirm a request that can't run. When it
   * returns text, that is what the request comes to as the check found it, and
   * the user confirms that instead. Its imports are dynamic: reading the
   * registry must load no SDK.
   */
  readonly check?: (params: Readonly<Record<string, unknown>>, call: ToolCheckCall) => Promise<string | void>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly annotations?: ToolAnnotations;
  /**
   * Its parameters, in its schema's order. With `argv.flags: 'rest'`, its
   * command's other flags that agents may pass and that apply to its
   * subcommand follow, in the definition's order.
   */
  readonly params: readonly ToolParam[];
  /** The parameters its schema marks required. */
  readonly required?: readonly string[];
  readonly argv: ToolArgv;
  readonly confirmation?: ToolConfirmation;
  /** Its place in the server's tool list, which does not follow the commands' order (cache_clear sits among config's tools). */
  readonly order: number;
}

export interface CommandDefinition {
  readonly name: string;
  /** Its place among the installed commands, which help lists in this order; a plugin takes one no other command has. */
  readonly order: number;
  readonly subcommands?: readonly string[];
  /** Other spellings its handler takes for a subcommand: `ls` for `list`. */
  readonly subcommandAliases?: Readonly<Record<string, string>>;
  readonly flags: readonly FlagDefinition[];
  /** Absent: help does not list the command. */
  readonly help?: CommandHelp;
  /** The intro's line for it, and its place there; absent: the intro does not list it. */
  readonly intro?: { readonly brief: string; readonly order: number };
  /** It starts the wallet SDK: the shell gives it more heap and exits when it ends. */
  readonly needsWalletSdk: boolean;
  readonly shell: ShellCall;
  /** Loads the handler. A static `import()` specifier, so the MCP server's bundler finds it. */
  readonly load: () => Promise<CommandModule>;
  /** Present when the MCP server can load its handler; its tools, possibly none. */
  readonly mcp?: { readonly tools: readonly ToolDefinition[] };
}

/** A package as the shell installs it: its commands and what it tells agents. */
export interface CommandPackage {
  readonly name: string;
  readonly commands: readonly CommandDefinition[];
  readonly guidance: PackageGuidance;
}

/** A tool as the registry holds it: its definition, its generated schema, and the command it runs. */
export interface RegisteredTool extends ToolDefinition {
  readonly inputSchema: ToolInputSchema;
  readonly command: CommandDefinition;
}

/** One entry of the global flags `help --json` lists, as it shows it. */
export interface GlobalFlagHelp {
  /** As shown, with its value and any short form: `--version, -v`. */
  readonly name: string;
  readonly description: string;
}

export interface CommandRegistry {
  /** The definitions, in help's order. */
  readonly commands: readonly CommandDefinition[];
  /** Flags every command accepts. */
  readonly globalFlags: readonly FlagDefinition[];
  /** The global flags `help --json` lists: the flags every command accepts, and the options most do. */
  readonly globalFlagsHelp: readonly GlobalFlagHelp[];
  find(name: string): CommandDefinition | undefined;
  /** Every MCP tool, in the server's order, each with its generated schema. */
  readonly tools: readonly RegisteredTool[];
  /** The installed packages, with their guidance; none when the registry was made from bare commands. */
  readonly packages: readonly CommandPackage[];
}

/** Thrown when definitions contradict each other or themselves. */
export class CommandDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandDefinitionError';
  }
}

function assertUnique(names: readonly string[], what: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new CommandDefinitionError(`${what} "${name}" is defined twice`);
    seen.add(name);
  }
}

function checkDefinition(command: CommandDefinition): void {
  assertUnique(command.flags.map((flag) => flag.name), `${command.name}: flag`);
  const byName = new Map(command.flags.map((flag) => [flag.name, flag]));
  const shown = new Set<string>();
  for (const entry of command.help?.flags ?? []) {
    if (typeof entry === 'string') continue;
    const flag = byName.get(entry.flag);
    if (flag?.help === undefined) throw new CommandDefinitionError(`${command.name}: help shows --${entry.flag}, which has no help lines`);
    if (shown.has(entry.flag)) throw new CommandDefinitionError(`${command.name}: help shows --${entry.flag} twice`);
    shown.add(entry.flag);
  }
  for (const [alias, sub] of Object.entries(command.subcommandAliases ?? {})) {
    if (!command.subcommands?.includes(sub)) throw new CommandDefinitionError(`${command.name}: "${alias}" stands for "${sub}", not one of its subcommands`);
  }
  for (const flag of command.flags) {
    if (flag.help !== undefined && !shown.has(flag.name)) throw new CommandDefinitionError(`${command.name}: --${flag.name} has help lines that help never shows`);
    for (const sub of flag.subcommands ?? []) {
      if (!command.subcommands?.includes(sub)) throw new CommandDefinitionError(`${command.name}: --${flag.name} applies to "${sub}", not one of its subcommands`);
    }
  }
}

function isParamSchema(agent: FlagDefinition['agent']): agent is ParamSchema {
  return agent !== undefined && !('notForAgents' in agent);
}

/** The flag applies to the tool's subcommand: it applies to all, or the tool runs one it names. */
function appliesTo(flag: FlagDefinition, tool: ToolDefinition): boolean {
  const sub = tool.argv.subcommand;
  return flag.subcommands === undefined || (typeof sub === 'string' && flag.subcommands.includes(sub));
}

/** The command's flags, then the global ones: what a tool of it could pass on. */
function flagsOf(command: CommandDefinition, globalFlags: readonly FlagDefinition[]): FlagDefinition[] {
  return [...command.flags, ...globalFlags];
}

function checkTool(command: CommandDefinition, tool: ToolDefinition, globalFlags: readonly FlagDefinition[]): void {
  const where = `${command.name}: ${tool.name}`;
  const flags = new Map(flagsOf(command, globalFlags).map((flag) => [flag.name, flag]));
  const names = tool.params.map((param) => ('flag' in param ? param.flag : param.name));
  assertUnique(names, `${where}: parameter`);
  const own = new Set<string>();
  for (const param of tool.params) {
    if ('flag' in param) {
      const flag = flags.get(param.flag);
      if (flag === undefined) throw new CommandDefinitionError(`${where} places --${param.flag}, which ${command.name} doesn't accept`);
      if (!isParamSchema(flag.agent)) throw new CommandDefinitionError(`${where} places --${param.flag}, which says no schema for agents`);
      if (!appliesTo(flag, tool)) throw new CommandDefinitionError(`${where} places --${param.flag}, which doesn't apply to its subcommand`);
    } else {
      if (flags.has(param.name)) throw new CommandDefinitionError(`${where}: its own parameter "${param.name}" is also a flag; place the flag instead`);
      own.add(param.name);
    }
  }
  const sub = tool.argv.subcommand;
  for (const name of [...(typeof sub === 'object' ? [sub.param] : []), ...(tool.argv.positionals ?? [])]) {
    if (!own.has(name)) throw new CommandDefinitionError(`${where}: "${name}" fills the subcommand or a positional but is not one of its own parameters`);
  }
  if (tool.argv.flags === 'rest') {
    for (const flag of flagsOf(command, globalFlags)) {
      if (appliesTo(flag, tool) && flag.agent === undefined) {
        throw new CommandDefinitionError(`${where} passes --${flag.name} on, which says neither how agents see it nor why they don't`);
      }
    }
  } else {
    for (const name of tool.argv.flags) {
      if (!names.includes(name)) throw new CommandDefinitionError(`${where}: its argv passes "${name}", which is not one of its parameters`);
    }
  }
  const properties = new Set(Object.keys(toolInputSchema(command, tool, globalFlags).properties));
  for (const name of tool.required ?? []) {
    if (!properties.has(name)) throw new CommandDefinitionError(`${where} requires "${name}", which its schema doesn't have`);
  }
}

/** A parameter's schema as tools/list sends it: type, then enum and description when there are. */
function shownSchema(schema: ParamSchema): ParamSchema {
  return {
    type: schema.type,
    ...(schema.enum === undefined ? {} : { enum: [...schema.enum] }),
    ...(schema.description === undefined ? {} : { description: schema.description }),
  };
}

/**
 * A tool's input schema: its own params and the flags it places, in its order,
 * then (when it passes the rest on) every other flag of its command an agent
 * may pass that applies to its subcommand, in the definition's order. The
 * server refuses a parameter outside it.
 */
export function toolInputSchema(command: CommandDefinition, tool: ToolDefinition, globalFlags: readonly FlagDefinition[]): ToolInputSchema {
  const flags = flagsOf(command, globalFlags);
  const properties: Record<string, ParamSchema> = {};
  for (const param of tool.params) {
    if ('flag' in param) {
      const agent = flags.find((flag) => flag.name === param.flag)?.agent;
      const schema = param.schema ?? (isParamSchema(agent) ? agent : undefined);
      if (schema === undefined) throw new CommandDefinitionError(`${command.name}: ${tool.name} places --${param.flag}, which says no schema for agents`);
      properties[param.flag] = shownSchema(schema);
    } else {
      properties[param.name] = shownSchema(param.schema);
    }
  }
  if (tool.argv.flags === 'rest') {
    for (const flag of flags) {
      if (Object.hasOwn(properties, flag.name) || !appliesTo(flag, tool) || !isParamSchema(flag.agent)) continue;
      properties[flag.name] = shownSchema(flag.agent);
    }
  }
  return { type: 'object', properties, ...(tool.required === undefined ? {} : { required: [...tool.required] }) };
}

/** A parameter that is there: not undefined, null or empty. */
function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** The command's argv for a call of the tool with these parameters, as its argv mapping says. */
export function toolArgv(tool: RegisteredTool, params: Readonly<Record<string, unknown>>): ParsedArgs {
  const { argv } = tool;
  const slot = argv.subcommand;
  const slotParam = typeof slot === 'object' ? slot.param : undefined;
  const subcommand = typeof slot === 'string' ? slot : slotParam !== undefined && given(params[slotParam]) ? String(params[slotParam]) : undefined;
  const positionals: string[] = [];
  for (const name of argv.positionals ?? []) {
    if (!given(params[name])) break;
    positionals.push(String(params[name]));
  }
  const consumed = new Set([...(slotParam === undefined ? [] : [slotParam]), ...(argv.positionals ?? [])]);
  const flags: Record<string, string | true> = { json: true };
  const passed = argv.flags === 'rest' ? Object.keys(params).filter((key) => !consumed.has(key)) : argv.flags;
  for (const key of passed) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (argv.flags !== 'rest' && !value) continue;
    // An agent's `full: true` asks for the human shape: the internal full-output flag.
    const flag = key === 'full' ? FULL_FLAG : key;
    if (typeof value === 'boolean') {
      if (value) flags[flag] = true;
    } else {
      flags[flag] = String(value);
    }
  }
  Object.assign(flags, argv.fixedFlags);
  for (const [name, value] of Object.entries(argv.defaultFlags ?? {})) {
    if (!flags[name]) flags[name] = value;
  }
  return { command: tool.command.name, subcommand, positionals, flags };
}

/** Collects definitions into a registry, refusing any that contradict each other. */
export function createCommandRegistry(
  commands: readonly CommandDefinition[],
  globalFlags: readonly FlagDefinition[],
  globalFlagsHelp: readonly GlobalFlagHelp[] = [],
): CommandRegistry {
  assertUnique(commands.map((command) => command.name), 'command');
  assertUnique(globalFlags.map((flag) => flag.name), 'global flag');
  commands.forEach(checkDefinition);
  for (const command of commands) {
    for (const tool of command.mcp?.tools ?? []) checkTool(command, tool, globalFlags);
  }
  const tools: RegisteredTool[] = commands.flatMap((command) => (command.mcp?.tools ?? []).map((tool) => ({
    ...tool,
    inputSchema: toolInputSchema(command, tool, globalFlags),
    command,
  })));
  assertUnique(tools.map((tool) => tool.name), 'MCP tool');
  assertUnique(tools.map((tool) => String(tool.order)), 'MCP tool place');
  const intro = commands.flatMap((command) => (command.intro === undefined ? [] : [String(command.intro.order)]));
  assertUnique(intro, 'intro place');
  return {
    commands,
    globalFlags,
    globalFlagsHelp,
    find: (name) => commands.find((command) => command.name === name),
    tools: tools.sort((a, b) => a.order - b.order),
    packages: [],
  };
}

/** Refuses guidance that contradicts itself or another package's: one place, one piece; a row only for the package's own tool, once. */
function checkGuidance(packages: readonly CommandPackage[]): void {
  try {
    assertDistinctPlaces(packages.flatMap((pkg) => pkg.guidance.pieces));
  } catch (err) {
    throw new CommandDefinitionError((err as Error).message);
  }
  const rows: ToolsTableRow[] = [];
  for (const pkg of packages) {
    const own = new Set(pkg.commands.flatMap((command) => (command.mcp?.tools ?? []).map((tool) => tool.name)));
    for (const row of pkg.guidance.toolsTable ?? []) {
      if (!own.has(row.tool)) throw new CommandDefinitionError(`${pkg.name}: its tools table has a row for ${row.tool}, which none of its commands defines`);
      rows.push(row);
    }
  }
  assertUnique(rows.map((row) => row.tool), 'tools table row for');
  assertUnique(rows.map((row) => `${row.group} ${row.order}`), 'tools table place');
}

/**
 * Collects packages into a registry, its commands in their definitions'
 * order. Every command is in one package.
 */
export function createPackageRegistry(
  packages: readonly CommandPackage[],
  globalFlags: readonly FlagDefinition[],
  globalFlagsHelp: readonly GlobalFlagHelp[] = [],
): CommandRegistry {
  assertUnique(packages.map((pkg) => pkg.name), 'package');
  const all = packages.flatMap((pkg) => pkg.commands);
  assertUnique(all.map((command) => command.name), 'command');
  assertUnique(all.map((command) => String(command.order)), 'command place');
  const commands = [...all].sort((a, b) => a.order - b.order);
  checkGuidance(packages);
  return { ...createCommandRegistry(commands, globalFlags, globalFlagsHelp), packages };
}

/** The Flags section of `help <command>`, line by line, as shown. */
export function flagsSectionLines(command: CommandDefinition): string[] {
  return (command.help?.flags ?? []).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : command.flags.find((flag) => flag.name === entry.flag)?.help ?? []);
}

/** One command as `help <command>`, `help --json` and `manual` show it: its help, the Flags section rendered. */
export interface CommandHelpSpec {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly flags?: readonly string[];
  readonly examples?: readonly string[];
  readonly jsonFields?: Readonly<Record<string, string>>;
}

/** Every command help lists, in the registry's order; a command with no help is left out. */
export function commandHelpSpecs(registry: Pick<CommandRegistry, 'commands'>): CommandHelpSpec[] {
  return registry.commands.flatMap((command) => {
    const help = command.help;
    if (help === undefined) return [];
    return [{
      name: command.name,
      description: help.description,
      usage: help.usage,
      ...(help.flags === undefined ? {} : { flags: flagsSectionLines(command) }),
      ...(help.examples === undefined ? {} : { examples: [...help.examples] }),
      ...(help.jsonFields === undefined ? {} : { jsonFields: { ...help.jsonFields } }),
    }];
  });
}

/** The intro's command list: each command with a brief, by its place there. */
export function introBriefs(registry: Pick<CommandRegistry, 'commands'>): [name: string, brief: string][] {
  return registry.commands
    .flatMap((command) => (command.intro === undefined ? [] : [{ name: command.name, ...command.intro }]))
    .sort((a, b) => a.order - b.order)
    .map(({ name, brief }) => [name, brief]);
}

/** The network and wallet a confirmation names: the ones given, or the active ones. */
export function confirmationTarget(params: Readonly<Record<string, unknown>>): { network: string; wallet: string } {
  return {
    network: (params.network as string | undefined) ?? 'active network',
    wallet: (params.wallet as string | undefined) ?? 'active wallet',
  };
}

/** The call needs the user's confirmation before it runs: the tool is confirmed, and its `when` doesn't exempt these parameters. */
export function needsConfirmation(tool: ToolDefinition, params: Readonly<Record<string, unknown>>): boolean {
  return tool.confirmation !== undefined && (tool.confirmation.when?.(params) ?? true);
}

/** The text a user confirms for a tool's call when its check gives none. */
export function confirmationText(tool: ToolDefinition, params: Readonly<Record<string, unknown>>): string {
  return tool.confirmation?.describe?.(params) ?? `Execute ${tool.name} with ${JSON.stringify(params)}`;
}
