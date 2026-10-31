// The CLI's prompter is made at start for every command, so making it must
// not touch stdin: only a command that prompts may open it (a piped stdin put
// into non-blocking mode breaks children that inherit it).

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('the terminal prompter', () => {
  it('does not touch stdin when it is made, only when it asks', () => {
    const run = spawnSync(resolve(ROOT, 'node_modules/.bin/tsx'), ['-e', `(async () => {
      let touched = 0;
      const own = Object.getOwnPropertyDescriptor(process, 'stdin');
      Object.defineProperty(process, 'stdin', { configurable: true, get() { touched++; return own.get.call(process); } });
      const { createTerminalPrompter } = await import(${JSON.stringify(resolve(ROOT, 'src/ui/terminal-prompter.ts'))});
      const prompter = createTerminalPrompter();
      const atCreation = touched;
      prompter.isInteractive();
      console.log(atCreation, touched > atCreation);
    })()`], { cwd: ROOT, encoding: 'utf8', input: '', timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('0 true');
  });
});
