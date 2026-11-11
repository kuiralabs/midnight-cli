// A shell concern: the host the CLI and the MCP server each build at start,
// which their calls pass to the libraries. A consumer builds its own.
//   - the guard against the SDK's transient rejections, with its console
//     filters, acting while a call listens (a rejection outside any call
//     exits 1), and the calls it runs, whose SDK warnings go to the call that
//     raised them;
//   - a notice sink: stderr;
//   - where waits are said (Dust for a fee): stderr in every mode, --json
//     included, as plain lines there;
//   - settings, read from the environment as each is needed;
//   - the state root, ~/.midnight, read as each path is built;
//   - the SDK engines this build ships, as its engine loader.
// The prompter is the CLI's alone: the MCP server has no terminal to ask at.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { installSdkProcessGuard } from '@kuiralabs/midnight-cli-core/process';
import { settingsFromEnvironment, type Prompter, MIDNIGHT_DIR, createHost, type Host } from '@kuiralabs/midnight-cli-core';
import { loadInstalledEngine } from './installed-engines.ts';

/** Colour and cursor codes, which a plain line leaves out. */
const TERMINAL_CODES = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * How a wait's line is written to stderr: plain (no colour, whole lines) for
 * --json and anything not a terminal; at a terminal, over the line a running
 * spinner is drawing, which then draws itself again below it.
 */
export function waitLineWriter(plain: boolean, isTerminal: boolean, write: (text: string) => void): (line: string) => void {
  if (plain) return (line) => write(line.replace(TERMINAL_CODES, '').trim() + '\n');
  return isTerminal ? (line) => write('\r\x1b[K' + line + '\n') : (line) => write(line + '\n');
}

/**
 * The CLI's host, or the MCP server's (`prompter` null: no terminal there).
 * Made once per process: each installs a process guard of its own. With
 * `notices` false (a --json run of the CLI without --verbose) the libraries'
 * notices are dropped, so stderr stays quiet but for the lines of a wait
 * (Dust for a fee), written plain: minutes with nothing said look like a hang.
 */
export function createCliHost({ prompter, notices = true, plainWaits = prompter === null }: { prompter: Prompter | null; notices?: boolean; /** Write a wait's lines plain (--json; the MCP server's log by default). */ plainWaits?: boolean }): Host {
  const stderr = (text: string): void => { process.stderr.write(text); };
  return createHost({
    settings: () => settingsFromEnvironment(process.env),
    paths: () => ({ stateRoot: join(homedir(), MIDNIGHT_DIR), home: homedir() }),
    notice: notices ? (line) => process.stderr.write(line + '\n') : () => {},
    waiting: waitLineWriter(plainWaits, process.stderr.isTTY === true, stderr),
    prompter,
    sdkWarnings: installSdkProcessGuard({ console: true, outsideCalls: 'exit' }).calls,
    engineLoader: loadInstalledEngine,
  });
}
