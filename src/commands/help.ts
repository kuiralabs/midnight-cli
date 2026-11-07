// help command — show usage for all commands or a specific command
// Horizontal layout: logo on left, commands on right; all help is on stdout
// Agent-friendly: plain text when piped (non-TTY)
// JSON mode: outputs capability manifest for agent self-discovery (with
// --agent, the agent manual too)
// Every list of commands it shows comes from the command registry, and the
// agent manual from the installed packages' guidance.

import { type ParsedArgs, hasFlag, commandHelpSpecs, introBriefs, type CommandHelpSpec, UsageError, type CallContext, type CallOutput } from '@kuiralabs/midnight-cli-core';
import { bold, teal, gray, dim, header } from '@kuiralabs/midnight-cli-core/ui';
import { animateMaterialize } from '../ui/animate.ts';
import { WORDMARK_BIG } from '../ui/art.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import { agentManual } from '../lib/agent-manual.ts';
import { commandCodeLines } from '../lib/code-tables.ts';
import { hasShownIntroThisSession, markIntroShown } from '../lib/intro-marker.ts';
import { PKG_NAME, PKG_VERSION, PKG_DESCRIPTION } from '../lib/pkg.ts';

type CommandSpec = CommandHelpSpec;

/** Every command help lists, from the registry. */
function helpSpecs(): CommandSpec[] {
  return commandHelpSpecs(installedCommands);
}

// Build the right column: wordmark (lines 0-2), blank, then commands
function buildRightColumn(): string[] {
  const lines: string[] = [];
  // Lines 0-2: big wordmark (animated by animateMaterialize)
  for (const wl of WORDMARK_BIG) {
    lines.push(wl);
  }
  // Line 3: blank
  lines.push('');
  // Line 4: header
  lines.push(bold('Commands'));
  // Lines 5+: command briefs
  for (const [name, brief] of introBriefs(installedCommands)) {
    lines.push(`${teal(name.padEnd(18))}${brief}`);
  }
  // Footer
  lines.push('');
  lines.push(dim(`midnight (or mn) help <command>`));
  lines.push(dim(`--json flag available on all commands`));
  lines.push(dim(`midnight help --agent`) + dim(`  AI & MCP reference`));
  return lines;
}

// Plain text output for non-TTY / agent-friendly
function printPlainHelp(output: CallOutput): void {
  output.stdout('\nCommands:\n\n');
  for (const [name, brief] of introBriefs(installedCommands)) {
    output.stdout(`  ${name.padEnd(18)}${brief}\n`);
  }
  output.stdout('\n  Usage: midnight <command> (or: mn <command>)\n');
  output.stdout('  --json flag available on all commands\n');
  output.stdout('  midnight help --agent   AI & MCP reference\n\n');
}

function printCommandHelp(output: CallOutput, spec: CommandSpec): void {
  output.stdout('\n' + header(spec.name) + '\n\n');
  output.stdout(`  ${spec.description}\n\n`);
  output.stdout(gray('Usage:') + '\n');
  output.stdout(`  ${spec.usage}\n\n`);

  if (spec.flags && spec.flags.length > 0) {
    output.stdout(gray('Flags:') + '\n');
    for (const flag of spec.flags) {
      output.stdout(`  ${flag}\n`);
    }
    output.stdout('\n');
  }

  if (spec.examples && spec.examples.length > 0) {
    output.stdout(gray('Examples:') + '\n');
    for (const example of spec.examples) {
      output.stdout(`  ${dim('$')} ${example}\n`);
    }
    output.stdout('\n');
  }

  output.stdout(gray('Errors:') + '\n');
  for (const line of commandCodeLines(spec, 2)) output.stdout(`${line}\n`);
  output.stdout('\n');
}

/** The capability manifest: every command's, or only `only`'s; with `agentManual`, the agent manual beside it. */
function outputJsonManifest(ctx: CallContext, only: CommandSpec | undefined, agentManualText?: string): void {
  const manifest = {
    cli: {
      name: PKG_NAME,
      version: PKG_VERSION,
      description: PKG_DESCRIPTION,
      bin: ['midnight', 'mn'],
    },
    globalFlags: installedCommands.globalFlagsHelp.map(flag => ({ name: flag.name, description: flag.description })),
    commands: (only === undefined ? helpSpecs() : [only]).map(spec => ({
      name: spec.name,
      description: spec.description,
      usage: spec.usage,
      flags: spec.flags,
      examples: spec.examples,
      jsonFields: spec.jsonFields,
      errorCodes: spec.errorCodes.map(({ code, exitCode }) => ({ code, exitCode })),
      errorSets: spec.errorSets,
      exitCodes: spec.exitCodes,
    })),
    ...(agentManualText === undefined ? {} : { agentManual: agentManualText }),
  };

  ctx.output.result(manifest);
}

// The agent manual: the shell's skeleton and each installed package's pieces.
function printAgentManual(output: CallOutput): void {
  output.stdout(agentManual(installedCommands));
}

/** The help of the command named `name`; a UsageError naming the installed ones when there is none. */
function specNamed(name: string): CommandSpec {
  const specs = helpSpecs();
  const spec = specs.find(s => s.name === name);
  if (!spec) {
    throw new UsageError(
      `Unknown command: "${name}"\n` +
      `Available commands: ${specs.map(s => s.name).join(', ')}`
    );
  }
  return spec;
}

export default async function helpCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  // Specific command help: wallet help <command>. An unknown one is a usage
  // error whatever else is asked, --json included.
  const targetCommand = args.subcommand;
  const spec = targetCommand === undefined ? undefined : specNamed(targetCommand);
  const jsonMode = hasFlag(args, 'json');

  // Agent manual: comprehensive reference for AI agents
  if (hasFlag(args, 'agent')) {
    if (jsonMode) outputJsonManifest(ctx, spec, agentManual(installedCommands));
    else printAgentManual(ctx.output);
    return;
  }

  // JSON mode: output capability manifest
  if (jsonMode) {
    outputJsonManifest(ctx, spec);
    return;
  }

  if (spec) {
    printCommandHelp(ctx.output, spec);
    return;
  }

  // General help: horizontal layout (logo + commands side by side)
  if (!process.stdout.isTTY) {
    // Agent-friendly: plain text, no animation, no ANSI
    printPlainHelp(ctx.output);
    return;
  }
  const rightColumn = buildRightColumn();

  // Cinematic logo materialize plays only on the first invocation in this
  // shell session. Follow-up calls render the same layout statically so
  // viewers who just want the help text are not made to wait.
  // Override with `--intro` to force the animation, `--no-intro` to skip it.
  const forceIntro = hasFlag(args, 'intro');
  const skipIntro = hasFlag(args, 'no-intro');
  const seen = hasShownIntroThisSession();
  const animated = forceIntro || (!skipIntro && !seen);

  await animateMaterialize(undefined, rightColumn, { animated, write: ctx.output.stdout });
  if (animated) markIntroShown();
}

export { helpSpecs };
export type { CommandSpec };
