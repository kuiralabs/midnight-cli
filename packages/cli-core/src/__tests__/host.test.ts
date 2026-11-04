// The host a program creates and passes in: what it gives when told nothing,
// values or functions read when used, and state kept per host.

import { describe, expect, it } from 'vitest';
import { createHost, defineHostSlot } from '../lib/host.ts';
import { NoStateRootError } from '../lib/state-root.ts';
import { settingsFromEnvironment } from '../lib/settings.ts';
import { type Prompter } from '../lib/prompter.ts';

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
