// midnight-wallet-cli entry point
// Usage: midnight <command> [args]  (or: mn <command> [args])
// Dispatches to command handlers via dynamic import
// Also supports: midnight --mcp (starts MCP server for AI agent integration)

import { parseArgs, hasFlag, assertKnownFlags, type CommandOutcome, classifyError, humanizeNetworkError, asReported, isUsageError, writeJsonError } from '@kuiralabs/midnight-cli-core';
import { errorMessage, usageMessage, createTerminalPrompter } from '@kuiralabs/midnight-cli-core/ui';
import { installedCommands } from './lib/installed-commands.ts';
import { commandNeedsWalletSdk, dispatchCommand, jsonModeOutput, processOutput } from './lib/command-dispatch.ts';
import { PKG_NAME, PKG_VERSION } from './lib/pkg.ts';
import { migrateOldWallet } from '@kuiralabs/midnight-wallet';
import { ensureHeapForSync } from './lib/heap-guard.ts';
import { assertNodeSupported } from './lib/node-version.ts';
import { hideProjectIdsInOutput } from './lib/output-redaction.ts';
import { createCliHost } from './lib/cli-host.ts';
import { ignoreClosedReaders } from './lib/closed-reader.ts';

// --mcp: start MCP server instead of CLI (for: npx midnight-wallet-cli --mcp)
if (process.argv.includes('--mcp')) {
  await ensureHeapForSync(); // MCP server runs facades on demand — give it the same headroom
  await import('./mcp-server.ts');
} else {

// A reader that closes early (| head, | grep -q) is not a failure: see lib/closed-reader.ts.
ignoreClosedReaders();

const args = parseArgs();
const jsonMode = hasFlag(args, 'json');

// Global --version / -v handling: the version, or with --json the version as JSON.
if (hasFlag(args, 'version') || hasFlag(args, 'v')) {
  process.stdout.write((jsonMode ? JSON.stringify({ name: PKG_NAME, version: PKG_VERSION }) : PKG_VERSION) + '\n');
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
// stderr (none under --json, unless --verbose asks for its lines), settings
// from the environment, the state root ~/.midnight, and the terminal to ask
// their questions (passphrase, approvals) at.
const host = createCliHost({ prompter: createTerminalPrompter(), notices: !jsonMode || hasFlag(args, 'verbose') });

// Auto-migrate old ~/.midnight/wallet.json → wallets/default.json (silent, one-time)
migrateOldWallet(host.paths().stateRoot);

// Global AbortController for clean shutdown on SIGINT/SIGTERM. The call
// stops on its signal and ends CANCELLED (exit 7), with its JSON under --json.
// Only a call that has not ended 5 s later is cut off, with the shell's code
// for the signal: 130 for SIGINT, 143 for SIGTERM. (A repeated signal is not
// taken as "stop now": Ctrl+C reaches a re-exec'd child twice, from the
// terminal and forwarded by its parent, lib/heap-guard.ts.)
const abortController = new AbortController();
const { signal } = abortController;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

function handleShutdown(received: keyof typeof SIGNAL_EXIT_CODES) {
  if (abortController.signal.aborted) return;
  abortController.abort();
  setTimeout(() => process.exit(SIGNAL_EXIT_CODES[received]), 5_000).unref();
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

async function run(): Promise<CommandOutcome | void> {
  // An unrecognised flag is refused before anything runs, instead of being
  // ignored and the command falling back to defaults.
  if (!helpRequested) assertKnownFlags(args, installedCommands);
  // Help still shows on a Node.js too old for the wallet SDK; nothing else runs there.
  if (command !== 'help') assertNodeSupported();
  // The command, what the shell gives its handler, a notice or a refusal: all from its definition.
  return dispatchCommand(installedCommands, command, args, {
    signal,
    // --json keeps stderr quiet: the result (or the error) on stdout is all there is.
    output: jsonMode ? jsonModeOutput(processOutput) : processOutput,
    host,
    payer: async () => (await import('@kuiralabs/midnight-connect')).servePayer,
    // wallet protect also seals grant's accounts, through the protector grant provides.
    protectors: async () => [(await import('@kuiralabs/midnight-grant')).accountProtector],
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
  // A node's refusal is reported in the node's words, also when a command wrapped it.
  const err = asReported(thrown);
  // The code and exit code come from the error's code, as the MCP server's do:
  // a usage error carries INVALID_ARGS unless its class names another
  // (PASSPHRASE_REQUIRED). Usage errors (missing/unknown subcommand, bad args)
  // render in yellow with a softer "Usage" framing: the user's prompt to fix
  // and retry, not a system failure.
  const { exitCode, errorCode } = classifyError(err, installedCommands);
  const message = humanizeNetworkError(err.message);
  if (jsonMode) {
    writeJsonError(err, errorCode, exitCode);
  } else if (isUsageError(err)) {
    process.stderr.write('\n' + usageMessage(message, 'Run "midnight manual" for the full reference, or "midnight help <command>" for one command.') + '\n\n');
  } else {
    // An error with a code of its own says what to do; only one mn can't name (UNKNOWN) points at help.
    const suggestion = errorCode === 'UNKNOWN' ? 'Run "midnight help" for usage information.' : undefined;
    process.stderr.write('\n' + errorMessage(message, suggestion) + '\n\n');
  }
  process.exit(exitCode);
});

}
