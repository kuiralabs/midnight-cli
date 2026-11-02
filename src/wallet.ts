// midnight-wallet-cli entry point
// Usage: midnight <command> [args]  (or: mn <command> [args])
// Dispatches to command handlers via dynamic import
// Also supports: midnight --mcp (starts MCP server for AI agent integration)

import { parseArgs, hasFlag } from './lib/argv.ts';
import { errorMessage, usageMessage } from './ui/format.ts';
import { assertKnownFlags } from './lib/command-flags.ts';
import { withNodeReason } from './lib/sdk-errors.ts';
import { installedCommands } from './lib/installed-commands.ts';
import { commandNeedsWalletSdk, dispatchCommand, processOutput } from './lib/command-dispatch.ts';
import type { CommandOutcome } from './lib/call-context.ts';
import { classifyError, humanizeNetworkError, EXIT_INVALID_ARGS } from './lib/exit-codes.ts';
import { isUsageError } from './lib/errors.ts';
import { writeJsonError } from './lib/json-output.ts';
import { PKG_VERSION } from './lib/pkg.ts';
import { migrateOldWallet } from './lib/wallet-paths.ts';
import { ensureHeapForSync } from './lib/heap-guard.ts';
import { assertNodeSupported } from './lib/node-version.ts';
import { hideProjectIdsInOutput } from './lib/output-redaction.ts';
import { setPrompter } from './lib/prompter.ts';
import { createTerminalPrompter } from './ui/terminal-prompter.ts';
import { installCliHost } from './lib/cli-host.ts';

// --mcp: start MCP server instead of CLI (for: npx midnight-wallet-cli --mcp)
if (process.argv.includes('--mcp')) {
  await ensureHeapForSync(); // MCP server runs facades on demand — give it the same headroom
  await import('./mcp-server.ts');
} else {

const args = parseArgs();
const jsonMode = hasFlag(args, 'json');

// Global --version / -v handling
if (hasFlag(args, 'version') || hasFlag(args, 'v')) {
  process.stdout.write(PKG_VERSION + '\n');
  process.exit(0);
}

// Global --help / -h handling. `mn <cmd> --help` shows that command's help,
// as `mn help <cmd>` does, whatever other flags are present, so flag checking
// is skipped for it; with no command help lists, the general help.
const helpRequested = hasFlag(args, 'help') || hasFlag(args, 'h');
if (helpRequested) {
  const target = args.command !== undefined && installedCommands.find(args.command)?.help !== undefined ? args.command : undefined;
  args.command = 'help';
  args.positionals = [];
  if (target !== undefined && target !== 'help') {
    args.subcommand = target;
    args.flags = {};
  } else {
    args.subcommand = undefined;
  }
}

// Default to help when no command given
const command = args.command ?? 'help';

// Commands that start the wallet SDK (their definition's needsWalletSdk) may
// run a cold shielded/dust sync whose transient-garbage stream overflows
// Node's default heap, so they re-exec with more headroom before any SDK/WASM
// loads (see lib/heap-guard.ts). No-op for the others, for the re-exec'd
// child, and when the heap is already large enough — so help/version/config
// etc. pay nothing.
const needsWalletSdk = commandNeedsWalletSdk(installedCommands, command);
if (needsWalletSdk) await ensureHeapForSync();

// Endpoint URLs can carry a Blockfrost project id: nothing mn or its libraries print shows it.
hideProjectIdsInOutput();

// What the libraries get from their host: the SDK noise filters, notices on
// stderr, settings from the environment, and the state root ~/.midnight.
const host = installCliHost();

// Libraries ask their questions (passphrase, approvals) at the terminal.
setPrompter(createTerminalPrompter());

// Auto-migrate old ~/.midnight/wallet.json → wallets/default.json (silent, one-time)
migrateOldWallet();

// Global AbortController for clean shutdown on SIGINT/SIGTERM
const abortController = new AbortController();
const { signal } = abortController;

function handleShutdown() {
  abortController.abort();
  // Give active operations a moment to clean up, then force exit
  setTimeout(() => process.exit(130), 5_000).unref();
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

async function run(): Promise<CommandOutcome | void> {
  // An unrecognised flag is refused before anything runs, instead of being
  // ignored and the command falling back to defaults.
  if (!helpRequested) assertKnownFlags(args, installedCommands);
  // Help still shows on a Node.js too old for the wallet SDK; nothing else runs there.
  if (command !== 'help') assertNodeSupported();
  // The command, what the shell gives its handler, a notice or a refusal: all from its definition.
  return dispatchCommand(installedCommands, command, args, {
    signal,
    output: processOutput,
    sdkWarnings: host.sdkWarnings,
    loadPayer: async () => (await import('./lib/serve-payer.ts')).servePayer,
    // wallet protect also seals grant's accounts, through the protector grant provides.
    loadProtectors: async () => [(await import('./lib/grant/account-protector.ts')).accountProtector],
  });
}

run().then((outcome) => {
  // A command can finish without throwing and still have failed: a test run
  // whose suite fails returns its exit code, and the shell leaves with it.
  if (outcome !== undefined) process.exitCode = outcome.exitCode;
  // A command that started the wallet SDK leaves WebSocket connections in the
  // event loop that facade.stop() doesn't fully drain, so it exits explicitly.
  if (needsWalletSdk) {
    process.exit(process.exitCode ?? 0);
  }
}).catch((thrown: Error) => {
  // A node's refusal is reported with the node's words, which the wallet SDK keeps only among its causes.
  const err = withNodeReason(thrown);
  // Usage errors (missing/unknown subcommand, bad args) render in yellow
  // with a softer "Usage" framing. They are the user's prompt to fix and
  // retry, not a system failure. Exit code 2 (INVALID_ARGS).
  const message = humanizeNetworkError(err.message);
  if (isUsageError(err)) {
    if (jsonMode) {
      writeJsonError(err, 'INVALID_ARGS', EXIT_INVALID_ARGS);
    } else {
      process.stderr.write('\n' + usageMessage(message, 'Run "midnight manual" for the full reference, or "midnight help <command>" for one command.') + '\n\n');
    }
    process.exit(EXIT_INVALID_ARGS);
  } else if (jsonMode) {
    const { exitCode, errorCode } = classifyError(err);
    writeJsonError(err, errorCode, exitCode);
    process.exit(exitCode);
  } else {
    process.stderr.write('\n' + errorMessage(message, 'Run "midnight help" for usage information.') + '\n\n');
    const { exitCode } = classifyError(err);
    process.exit(exitCode);
  }
});

}
