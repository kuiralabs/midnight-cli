// The host a program creates and passes in: what it gives when told nothing,
// values or functions read when used, and state kept per host.

import { describe, expect, it } from 'vitest';
import { createHost, defineHostSlot } from '../lib/host.ts';
import { NoStateRootError } from '../lib/state-root.ts';
import { settingsFromEnvironment } from '../lib/settings.ts';
import { type Prompter } from '../lib/prompter.ts';
import { createSdkWarningRouter } from '../lib/sdk-warnings.ts';

describe('createHost', () => {
  it('gives, when told nothing: every setting unset, no state root, notices dropped, nobody to ask', () => {
    const host = createHost();
    expect(host.settings()).toEqual(settingsFromEnvironment({}));
    expect(() => host.paths()).toThrow(NoStateRootError);
    expect(() => host.notice('dropped')).not.toThrow();
    expect(host.prompter).toBeNull();
  });

  it('takes values', () => {
    const lines: string[] = [];
    const prompter: Prompter = { isInteractive: () => false, ask: async () => null, askSecret: async () => null };
    const host = createHost({
      paths: { stateRoot: '/state', home: '/home' },
      settings: settingsFromEnvironment({ MN_NO_LOCAL_DETECT: '1' }),
      notice: (line) => lines.push(line),
      prompter,
    });
    expect(host.paths()).toEqual({ stateRoot: '/state', home: '/home' });
    expect(host.settings().isLocalDetectOff).toBe(true);
    host.notice('one');
    expect(lines).toEqual(['one']);
    expect(host.prompter).toBe(prompter);
  });

  it('reads functions each time, so what they read can change', () => {
    let root = '/a';
    const env: Record<string, string> = {};
    const host = createHost({ paths: () => ({ stateRoot: root, home: '/home' }), settings: () => settingsFromEnvironment(env) });
    expect(host.paths().stateRoot).toBe('/a');
    root = '/b';
    env.MN_DISABLE_NATIVE_DUST = '1';
    expect(host.paths().stateRoot).toBe('/b');
    expect(host.settings().isNativeDustOff).toBe(true);
  });

  it("says a wait's lines where it shows waits, and gives the call they come from the opening one, as a notice", async () => {
    const notices: string[] = [];
    const waits: string[] = [];
    // A runner that knows the call running, as the process guard does.
    const call = createSdkWarningRouter().openCall().warnings;
    const host = createHost({ notice: (line) => notices.push(line), waiting: (line) => waits.push(line), sdkWarnings: { run: (run) => run(call), current: () => call } });
    const collected: string[] = [];
    await host.sdkWarnings.run(async (warnings) => {
      host.collectNotices(warnings, (line) => collected.push(line));
      host.waiting('Dust: 0.31 of the 3.17 DUST this fee takes; waiting about 5 minutes (269 s) for its registered NIGHT to generate the rest...', true);
      host.waiting('Dust: waited 15 s of 269 s, 0.43 of 3.17 DUST', false);
    });
    expect(waits).toHaveLength(2);
    expect(notices).toEqual([]);
    expect(collected).toEqual(['Dust: 0.31 of the 3.17 DUST this fee takes; waiting about 5 minutes (269 s) for its registered NIGHT to generate the rest...']);
  });

  it("says a wait's lines as notices when it has no place of its own for them", () => {
    const notices: string[] = [];
    const host = createHost({ notice: (line) => notices.push(line) });
    host.waiting('Dust: waited 15 s of 269 s, 0.43 of 3.17 DUST', false);
    expect(notices).toEqual(['Dust: waited 15 s of 269 s, 0.43 of 3.17 DUST']);
  });

  it('runs each call with its own SDK warnings when it is given no router', async () => {
    const host = createHost();
    const seen = await host.sdkWarnings.run(async (warnings) => typeof warnings.listen);
    expect(seen).toBe('function');
  });
});

describe('host slots', () => {
  const COUNTER = defineHostSlot('test counter', () => ({ n: 0 }));

  it('make a host\'s value on first use and keep it', () => {
    const host = createHost();
    host.slot(COUNTER).n += 1;
    host.slot(COUNTER).n += 1;
    expect(host.slot(COUNTER).n).toBe(2);
  });

  it('are per host: two hosts in one process share nothing', () => {
    const a = createHost();
    const b = createHost();
    a.slot(COUNTER).n = 5;
    expect(b.slot(COUNTER).n).toBe(0);
  });

  it('are per slot, even with the same name', () => {
    const other = defineHostSlot('test counter', () => ({ n: 9 }));
    const host = createHost();
    host.slot(COUNTER).n = 1;
    expect(host.slot(other).n).toBe(9);
  });
});
