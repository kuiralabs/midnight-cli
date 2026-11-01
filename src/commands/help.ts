// help command — show usage for all commands or a specific command
// Horizontal layout: logo on left, commands on right (all on stderr)
// Agent-friendly: plain text when piped (non-TTY)
// JSON mode: outputs capability manifest for agent self-discovery
// Every list of commands it shows comes from the command registry (plan 2D),
// and the agent manual from the installed packages' guidance (2G).

import { type ParsedArgs, hasFlag } from '../lib/argv.ts';
import { bold, teal, gray, dim } from '../ui/colors.ts';
import { header } from '../ui/format.ts';
import { animateMaterialize } from '../ui/animate.ts';
import { WORDMARK_BIG } from '../ui/art.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import { agentManual } from '../lib/agent-manual.ts';
import { commandHelpSpecs, introBriefs, type CommandHelpSpec } from '../lib/command-definition.ts';
import { hasShownIntroThisSession, markIntroShown } from '../lib/intro-marker.ts';
import { UsageError } from '../lib/errors.ts';
import type { CallContext, CallOutput } from '../lib/call-context.ts';
import { PKG_NAME, PKG_VERSION, PKG_DESCRIPTION } from '../lib/pkg.ts';
import { INDEXER_GRAPHQL_WS_PATH } from '../lib/constants.ts';

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
  output.stderr('\nCommands:\n\n');
  for (const [name, brief] of introBriefs(installedCommands)) {
    output.stderr(`  ${name.padEnd(18)}${brief}\n`);
  }
  output.stderr('\n  Usage: midnight <command> (or: mn <command>)\n');
  output.stderr('  --json flag available on all commands\n');
  output.stderr('  midnight help --agent   AI & MCP reference\n\n');
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
}

function outputJsonManifest(ctx: CallContext): void {
  const manifest = {
    cli: {
      name: PKG_NAME,
      version: PKG_VERSION,
      description: PKG_DESCRIPTION,
      bin: ['midnight', 'mn'],
    },
    globalFlags: installedCommands.globalFlagsHelp.map(flag => ({ name: flag.name, description: flag.description })),
    commands: helpSpecs().map(spec => ({
      name: spec.name,
      description: spec.description,
      usage: spec.usage,
      flags: spec.flags,
      examples: spec.examples,
      jsonFields: spec.jsonFields,
    })),
  };

  ctx.output.result(manifest);
}

// The agent manual: the shell's skeleton and each installed package's pieces (2G).
function printAgentManual(output: CallOutput): void {
  output.stdout(agentManual(installedCommands));
}

export default async function helpCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  // Agent manual: comprehensive reference for AI agents
  if (hasFlag(args, 'agent')) {
    printAgentManual(ctx.output);
    return;
  }

  // JSON mode: output capability manifest
  if (hasFlag(args, 'json')) {
    outputJsonManifest(ctx);
    return;
  }

  // Specific command help: wallet help <command>
  const targetCommand = args.subcommand;

  if (targetCommand) {
    const specs = helpSpecs();
    const spec = specs.find(s => s.name === targetCommand);
    if (!spec) {
      throw new UsageError(
        `Unknown command: "${targetCommand}"\n` +
        `Available commands: ${specs.map(s => s.name).join(', ')}`
      );
    }
    printCommandHelp(ctx.output, spec);
    return;
  }

  // General help: horizontal layout (logo + commands side by side)
  if (!process.stderr.isTTY) {
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

  await animateMaterialize(undefined, rightColumn, { animated });
  if (animated) markIntroShown();
}

export { helpSpecs };
export type { CommandSpec };
