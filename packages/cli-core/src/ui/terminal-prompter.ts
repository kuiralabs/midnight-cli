// The CLI's prompter: asks at a terminal on stderr, so stdout stays the
// command's result. A secret is typed with the terminal in raw mode, so
// nothing is echoed; Ctrl-C refuses. One terminal answers one question at a
// time: a question asked while another is open is refused (PromptBusyError).

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { UsageError } from '../lib/errors.ts';
import { PromptBusyError, type Prompter } from '../lib/prompter.ts';

export interface TerminalIo {
  input?: Readable & { setRawMode?: (mode: boolean) => unknown; isTTY?: boolean };
  output?: Writable;
  /** Overrides whether the input is a terminal. */
  isTTY?: boolean;
}

// One line from `input`. A real terminal is put in raw mode so nothing typed is
// echoed; the line ends at Enter, and Ctrl-C refuses. Null when the input ends first.
const hiddenLine = (input: NonNullable<TerminalIo['input']>): Promise<string | null> =>
  new Promise((resolve, reject) => {
    if (typeof input.setRawMode === 'function') {
      let typed = '';
      const onData = (chunk: Buffer): void => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') { finish(); resolve(typed); return; }
          if (char === '\u0003') { finish(); reject(new UsageError('Cancelled.')); return; }
          if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
          else typed += char;
        }
      };
      const finish = (): void => {
        input.removeListener('data', onData);
        input.setRawMode?.(false);
        input.pause();
      };
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      return;
    }
    const lines = createInterface({ input, terminal: false });
    lines.once('line', (line) => { resolve(line); lines.close(); });
    lines.once('close', () => resolve(null));
  });

export function createTerminalPrompter(io: TerminalIo = {}): Prompter {
  // Looked up when asked, never at creation: the CLI makes its prompter at
  // start, and only a command that prompts may touch stdin.
  const input = () => io.input ?? process.stdin;
  const output = () => io.output ?? process.stderr;
  // Whether a question is open now: this terminal's, so two prompters never block each other.
  let asking = false;
  const oneAtATime = async (question: () => Promise<string | null>): Promise<string | null> => {
    if (asking) throw new PromptBusyError();
    asking = true;
    try {
      return await question();
    } finally {
      asking = false;
    }
  };
  return {
    isInteractive: () => io.isTTY ?? input().isTTY === true,
    ask: (question) => oneAtATime(() => new Promise((resolve) => {
      const rl = createInterface({ input: input(), output: output() });
      let answered = false;
      rl.on('close', () => { if (!answered) resolve(null); });
      rl.question(question, (answer) => { answered = true; rl.close(); resolve(answer); });
    })),
    askSecret: (question) => oneAtATime(async () => {
      output().write(question);
      const line = await hiddenLine(input());
      output().write('\n');
      return line;
    }),
  };
}
