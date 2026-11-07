// Braille spinner for stderr — in-place updates via \r
// Supports interleaved log lines without breaking the animation

import { teal, isColorEnabled } from './colors.ts';
import type { ProgressEvent } from '../lib/progress.ts';

const BRAILLE_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;

export interface Spinner {
  update(message: string): void;
  stop(finalMessage?: string): void;
  /** Stop the spinner with a failure mark (red ✗) instead of the default ✓. */
  fail(finalMessage?: string): void;
  /** Write a log line without breaking the spinner animation. */
  log(line: string): void;
  /** Stop the spinner and erase its line, leaving nothing: the caller writes its own outcome. */
  clear(): void;
}

/**
 * Where what a call's spinners say goes besides the terminal: for a call the
 * MCP server runs, its progress notifications. Each call has its own; a
 * spinner made without one reports nowhere.
 */
export type ProgressReport = (message: string) => void;

const reportNowhere: ProgressReport = () => {};

/** A spinner that shows nothing, for `--json` callers: stdout stays the result alone and stderr stays quiet. What it would say still goes to `report`. */
export function silentSpinner(report: ProgressReport = reportNowhere): Spinner {
  const say = (message: string | undefined): void => {
    if (message !== undefined) report(message);
  };
  return { update: say, stop: say, fail() {}, log: say, clear() {} };
}

/** One call's progress: the spinners of its steps, what they say to its `report`, and which one is running now. */
export interface Progress {
  /** Starts a spinner for a step. */
  start(message: string): Spinner;
  /** A spinner that shows nothing (`--json`); what it would say still reaches the call's report. */
  silent(): Spinner;
  /** The call's spinner that is running now, if any. */
  active(): Spinner | null;
}

/** The progress of one call, whose spinners say what they say to `report` too. */
export function createProgress(report: ProgressReport = reportNowhere, write: TerminalWrite = writeStderr): Progress {
  let active: Spinner | null = null;
  return {
    start(message) {
      const spinner = start(message, report, (ended) => {
        if (active === ended) active = null;
      }, write);
      active = spinner;
      return spinner;
    },
    silent: () => silentSpinner(report),
    active: () => active,
  };
}

/** A library function's progress, shown on a call's spinners: one spinner per step. */
export interface SpinnerReporter {
  /** Shows one event: a step's start opens a spinner, its updates change it, its end stops it. */
  report(event: ProgressEvent): void;
  /** Stops the running step's spinner with a failure mark, as a handler does when the function throws. */
  fail(message?: string): void;
}

/**
 * Shows a library function's steps on `progress`'s spinners. `silent` (a
 * `--json` call) shows nothing on the terminal, while what each step says,
 * its start included, still reaches the call's report (the MCP server's
 * progress notifications).
 */
export function spinnerReporter(progress: Progress, silent: boolean): SpinnerReporter {
  let current: Spinner | null = null;
  return {
    report(event) {
      if (event.kind === 'start') {
        current?.stop();
        if (silent) {
          current = progress.silent();
          current.update(event.message);
        } else {
          current = progress.start(event.message);
        }
      } else if (event.kind === 'update') {
        current?.update(event.message);
      } else {
        current?.stop(event.message);
        current = null;
      }
    },
    fail(message) {
      current?.fail(message);
      current = null;
    },
  };
}

/** Strip ANSI escape codes for accurate visible-length measurement. */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Where a spinner draws: a call's stderr, or the process's for a spinner outside any call. */
export type TerminalWrite = (text: string) => void;

const writeStderr: TerminalWrite = (text) => { process.stderr.write(text); };

/**
 * Starts a spinner on the terminal (`write`, stderr by default) saying `message`; what it says
 * goes to `report` too. `onEnd` hears when it stops, fails or clears.
 */
export function start(message: string, report: ProgressReport = reportNowhere, onEnd: (spinner: Spinner) => void = () => {}, write: TerminalWrite = writeStderr): Spinner {
  let stopped = false;
  const say = (said: string | undefined): void => {
    if (said !== undefined) report(said);
  };
  say(message);

  // Not at a terminal (a file or a pipe): whole lines only, no carriage
  // return or erase-line code, and each step once, as it ends.
  if (process.stderr.isTTY !== true) {
    let currentMessage = message;
    const spinner: Spinner = {
      update(msg: string) {
        currentMessage = msg;
        say(msg);
      },
      stop(finalMessage?: string) {
        if (stopped) return;
        stopped = true;
        onEnd(spinner);
        say(finalMessage);
        write(`✓ ${finalMessage ?? currentMessage}\n`);
      },
      fail(finalMessage?: string) {
        if (stopped) return;
        stopped = true;
        onEnd(spinner);
        write(`✗ ${finalMessage ?? currentMessage}\n`);
      },
      log(line: string) {
        say(line);
        write(`${line}\n`);
      },
      clear() {
        if (stopped) return;
        stopped = true;
        onEnd(spinner);
      },
    };
    return spinner;
  }

  if (!isColorEnabled()) {
    let currentMessage = message;
    write(`⠋ ${currentMessage}`);
    const spinner: Spinner = {
      update(msg: string) {
        currentMessage = msg;
        say(msg);
        write(`\r⠋ ${currentMessage}\x1b[K`);
      },
      stop(finalMessage?: string) {
        if (stopped) return;
        stopped = true;
        onEnd(spinner);
        say(finalMessage);
        write(`\r✓ ${finalMessage ?? currentMessage}\x1b[K\n`);
      },
      fail(finalMessage?: string) {
        if (stopped) return;
        stopped = true;
        onEnd(spinner);
        write(`\r✗ ${finalMessage ?? currentMessage}\x1b[K\n`);
      },
      log(line: string) {
        say(line);
        write(`\r\x1b[K${line}\n`);
        write(`⠋ ${currentMessage}`);
      },
      clear() {
        if (stopped) return;
        stopped = true;
        onEnd(spinner);
        write('\r\x1b[K');
      },
    };
    return spinner;
  }

  let frameIndex = 0;
  let currentMessage = message;

  const render = () => {
    const frame = teal(BRAILLE_FRAMES[frameIndex]!);
    // Truncate by visible length to prevent line wrapping (breaks \r)
    const cols = process.stderr.columns || 80;
    const maxVisible = cols - 4; // "⠋ " prefix + safety margin
    let text = currentMessage;
    if (stripAnsi(text).length > maxVisible) {
      // Truncate the raw message (before any ANSI), then let callers re-apply color
      const plain = stripAnsi(text);
      text = plain.slice(0, maxVisible);
    }
    write(`\r${frame} ${text}\x1b[K`);
    frameIndex = (frameIndex + 1) % BRAILLE_FRAMES.length;
  };

  render();
  const timer = setInterval(render, FRAME_INTERVAL_MS);

  const spinner: Spinner = {
    update(msg: string) {
      currentMessage = msg;
      say(msg);
    },
    stop(finalMessage?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      onEnd(spinner);
      say(finalMessage);
      const final = finalMessage ?? currentMessage;
      write(`\r\x1b[32m✓\x1b[0m ${final}\x1b[K\n`);
    },
    fail(finalMessage?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      onEnd(spinner);
      const final = finalMessage ?? currentMessage;
      write(`\r\x1b[31m✗\x1b[0m ${final}\x1b[K\n`);
    },
    log(line: string) {
      say(line);
      write(`\r\x1b[K${line}\n`);
      render();
    },
    clear() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      onEnd(spinner);
      write('\r\x1b[K');
    },
  };

  return spinner;
}

/**
 * Update `spinner` once a second with `${baseMessage} MM:SS` while `promise`
 * is pending. Used for waits that can't report real progress (e.g. waiting
 * for chain finalization) so users see something is moving, not stuck.
 *
 * The interval clears in a finally block so timeouts and rejections are
 * also clean. Returns whatever `promise` resolves to.
 */
export async function trackElapsed<T>(
  spinner: Spinner,
  baseMessage: string,
  promise: Promise<T>,
): Promise<T> {
  const started = Date.now();
  const formatElapsed = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const mm = Math.floor(s / 60).toString().padStart(2, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  };
  const tick = () => spinner.update(`${baseMessage} ${formatElapsed(Date.now() - started)}`);
  tick();
  const interval = setInterval(tick, 1000);
  try {
    return await promise;
  } finally {
    clearInterval(interval);
  }
}

export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const spinner = start(message);
  try {
    const result = await fn();
    spinner.stop();
    return result;
  } catch (err) {
    spinner.fail(`Failed: ${message}`);
    throw err;
  }
}
