// The CLI's prompter is made at start for every command, so making it must
// not touch stdin: only a command that prompts may open it (a piped stdin put
// into non-blocking mode breaks children that inherit it).

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createTerminalPrompter } from '@kuiralabs/midnight-cli-core/ui/terminal-prompter';
import { PromptBusyError } from '@kuiralabs/midnight-cli-core/lib/prompter';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('the terminal prompter', () => {
  it('does not touch stdin when it is made, only when it asks', () => {
    const run = spawnSync(resolve(ROOT, 'node_modules/.bin/tsx'), ['-e', `(async () => {
      let touched = 0;
      const own = Object.getOwnPropertyDescriptor(process, 'stdin');
      Object.defineProperty(process, 'stdin', { configurable: true, get() { touched++; return own.get.call(process); } });
      const { createTerminalPrompter } = await import(${JSON.stringify(resolve(ROOT, 'packages/cli-core/src/ui/terminal-prompter.ts'))});
      const prompter = createTerminalPrompter();
      const atCreation = touched;
      prompter.isInteractive();
      console.log(atCreation, touched > atCreation);
    })()`], { cwd: ROOT, encoding: 'utf8', input: '', timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('0 true');
  });
});

// One terminal, one question at a time. The busy flag was a module
// global in approval.ts; it is the prompter's own now.
describe('the terminal prompter asks one question at a time', () => {
  const terminal = () => {
    const input = new PassThrough();
    return { input, prompter: createTerminalPrompter({ input, output: new PassThrough(), isTTY: true }) };
  };

  it('refuses a second question while one is open, a secret one too, and asks again once it is answered', async () => {
    const { input, prompter } = terminal();
    const first = prompter.ask('Approve? ');
    await expect(prompter.ask('Approve this too? ')).rejects.toBeInstanceOf(PromptBusyError);
    await expect(prompter.askSecret('Passphrase: ')).rejects.toBeInstanceOf(PromptBusyError);
    input.write('a\n');
    expect(await first).toBe('a');
    const next = prompter.ask('Approve? ');
    input.write('r\n');
    expect(await next).toBe('r');
  });

  it('is free again once a question ends without an answer: the input ending, or Ctrl-C', async () => {
    const ended = terminal();
    const unanswered = ended.prompter.ask('Approve? ');
    ended.input.end();
    expect(await unanswered).toBeNull();
    // Taken, not refused: it waits for an answer the ended input will never give.
    const taken = ended.prompter.ask('Approve? ').catch((err: unknown) => err);
    expect(await Promise.race([taken, new Promise((resolve) => setTimeout(() => resolve('waiting'), 20))])).toBe('waiting');

    // A terminal in raw mode: a secret refused with Ctrl-C, then the next question is asked.
    const input = Object.assign(new PassThrough(), { setRawMode: () => input });
    const prompter = createTerminalPrompter({ input, output: new PassThrough(), isTTY: true });
    const secret = prompter.askSecret('Passphrase: ');
    input.write('\u0003');
    await expect(secret).rejects.toThrow('Cancelled.');
    const next = prompter.ask('Approve? ');
    input.write('y\n');
    expect(await next).toBe('y');
  });

  it('two prompters never block each other: each has its own terminal', async () => {
    const one = terminal();
    const two = terminal();
    const asked = one.prompter.ask('One? ');
    const alsoAsked = two.prompter.ask('Two? ');
    two.input.write('second\n');
    one.input.write('first\n');
    expect(await alsoAsked).toBe('second');
    expect(await asked).toBe('first');
  });
});
