// One command, described once (spec §4.1, plan 2B): its subcommands, flags,
// help, the intro's line, whether it needs the wallet SDK, what the shell
// passes its handler, its handler, and its MCP tools. Plain data and a lazily
// loaded handler, tied to no CLI framework (D10). Each command's definition
// sits beside it (src/commands/<name>.definition.ts) and must not load the
// handler's module until asked, so reading the registry loads no SDK.
//
// In 2B nothing reads the registry yet but its tests, which rebuild every
// existing list from it. Where those lists disagree today, a definition
// records what each says, so every rebuild is exact; Y29 (the plan's STATUS)
// fixes the disagreements in 2C–2G.

import type { ParsedArgs } from './argv.ts';

/** A flag a command accepts. */
export interface FlagDefinition {
  /** As typed after `--` (or `-`, for one letter). */
  readonly name: string;
  /** `--name <value>`, read as a string; otherwise a bare switch. */
  readonly takesValue: boolean;
  /** The subcommands it applies to, as the command's help says; absent: all of them. */
  readonly subcommands?: readonly string[];
  /** Its lines in `help <command>`'s Flags section, exactly as shown; absent: help doesn't list it. */
  readonly help?: readonly string[];
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

/** What the shell does for a command around its handler. */
export interface ShellCall {
  /** The handler gets the shell's cancellation signal. */
  readonly signal?: true;
  /** The handler gets the shell's payer, the served wallet (D24). */
  readonly payer?: true;
  /** The handler gets the protectors other packages provide (wallet protect, D24). */
  readonly protectors?: true;
  /** Written to stderr before the handler runs. */
  readonly notice?: string;
  /** The shell refuses the command with this message instead of loading it. */
  readonly unavailable?: string;
}

/** A command's module. Method syntax: each handler takes its context in its own shape until 2F gives them one. */
export interface CommandModule {
  default(args: ParsedArgs, signal?: AbortSignal, context?: unknown): Promise<void>;
}

/** The MCP tool annotations the server sends. */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, { readonly type: string; readonly description?: string; readonly enum?: readonly string[] }>>;
  readonly required?: readonly string[];
}

/**
 * How a tool's parameters become the command's argv. `--json` is always set,
 * and a `full` parameter becomes the internal full-output flag.
 */
export interface ToolArgv {
  /** The subcommand slot: a fixed subcommand, or the parameter whose value fills it. */
  readonly subcommand?: string | { readonly param: string };
  /** Parameters that become positionals, in order; one not given is left out. */
  readonly positionals?: readonly string[];
  /**
   * The parameters that become flags: 'rest' is every other one (one not
   * given is left out, `true` is a bare flag and `false` none, anything else
   * its string); a list is only those, each when given a truthy value.
   */
  readonly flags: 'rest' | readonly string[];
  /** Flags whose string value "true" becomes a bare flag. */
  readonly trueStrings?: readonly string[];
  /** Flags always set. */
  readonly fixedFlags?: Readonly<Record<string, true>>;
  /** Flag values used when the parameter is not given (or empty). */
  readonly defaultFlags?: Readonly<Record<string, string>>;
}

/** A tool behind the two-step confirmation. */
export interface ToolConfirmation {
  /** The text the user confirms, from the tool's parameters; absent: the tool's check works it out. */
  readonly describe?: (params: Readonly<Record<string, unknown>>) => string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly annotations?: ToolAnnotations;
  readonly inputSchema: ToolInputSchema;
  readonly argv: ToolArgv;
  readonly confirmation?: ToolConfirmation;
  /** Its place in the server's tool list, which does not follow the commands' order (cache_clear sits among config's tools). */
  readonly order: number;
}

export interface CommandDefinition {
  readonly name: string;
  readonly subcommands?: readonly string[];
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

export interface CommandRegistry {
  /** The definitions, in help's order. */
  readonly commands: readonly CommandDefinition[];
  /** Flags every command accepts. */
  readonly globalFlags: readonly FlagDefinition[];
  find(name: string): CommandDefinition | undefined;
  /** Every MCP tool, in the server's order. */
  readonly tools: readonly ToolDefinition[];
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
  for (const flag of command.flags) {
    if (flag.help !== undefined && !shown.has(flag.name)) throw new CommandDefinitionError(`${command.name}: --${flag.name} has help lines that help never shows`);
    for (const sub of flag.subcommands ?? []) {
      if (!command.subcommands?.includes(sub)) throw new CommandDefinitionError(`${command.name}: --${flag.name} applies to "${sub}", not one of its subcommands`);
    }
  }
}

/** Collects definitions into a registry, refusing any that contradict each other. */
export function createCommandRegistry(commands: readonly CommandDefinition[], globalFlags: readonly FlagDefinition[]): CommandRegistry {
  assertUnique(commands.map((command) => command.name), 'command');
  assertUnique(globalFlags.map((flag) => flag.name), 'global flag');
  commands.forEach(checkDefinition);
  const tools = commands.flatMap((command) => command.mcp?.tools ?? []);
  assertUnique(tools.map((tool) => tool.name), 'MCP tool');
  assertUnique(tools.map((tool) => String(tool.order)), 'MCP tool place');
  const intro = commands.flatMap((command) => (command.intro === undefined ? [] : [String(command.intro.order)]));
  assertUnique(intro, 'intro place');
  return {
    commands,
    globalFlags,
    find: (name) => commands.find((command) => command.name === name),
    tools: [...tools].sort((a, b) => a.order - b.order),
  };
}

/** The Flags section of `help <command>`, line by line, as shown. */
export function flagsSectionLines(command: CommandDefinition): string[] {
  return (command.help?.flags ?? []).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : command.flags.find((flag) => flag.name === entry.flag)?.help ?? []);
}

/** The network and wallet a confirmation names: the ones given, or the active ones. */
export function confirmationTarget(params: Readonly<Record<string, unknown>>): { network: string; wallet: string } {
  return {
    network: (params.network as string | undefined) ?? 'active network',
    wallet: (params.wallet as string | undefined) ?? 'active wallet',
  };
}

/** The text a user confirms for a tool's call when its check gives none. */
export function confirmationText(tool: ToolDefinition, params: Readonly<Record<string, unknown>>): string {
  return tool.confirmation?.describe?.(params) ?? `Execute ${tool.name} with ${JSON.stringify(params)}`;
}
