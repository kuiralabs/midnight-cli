// The lines a long step says on a host's `waiting`, in every mode: nothing
// for a quick step, then where it is every WAIT_LINE_EVERY_MS.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WAIT_LINE_EVERY_MS, eventsReadDoneLine, eventsReadLine, provingLine, sayWhileRunning, stepLines } from '../lib/wait-lines.ts';

afterEach(() => { vi.useRealTimers(); });

type Said = Array<[string, boolean]>;
const recorder = () => {
  const said: Said = [];
  return { said, say: (line: string, opening: boolean) => { said.push([line, opening]); } };
};

describe('stepLines', () => {
  it('says nothing for the step\'s first WAIT_LINE_EVERY_MS, then a line at most every WAIT_LINE_EVERY_MS, and the end only when it said something', () => {
    let now = 0;
    const { said, say } = recorder();
    const lines = stepLines(say, { now: () => now });
    lines.progress('at 1 s');
    now = WAIT_LINE_EVERY_MS - 1;
    lines.progress('just before');
    now = WAIT_LINE_EVERY_MS;
    lines.progress('first');
    now = WAIT_LINE_EVERY_MS + 5_000;
    lines.progress('too soon');
    now = 2 * WAIT_LINE_EVERY_MS + 5_000;
    lines.progress('second');
    lines.done('ended');
    lines.progress('after the end');
    expect(said).toEqual([['first', false], ['second', false], ['ended', false]]);

    const quick = recorder();
    const quickLines = stepLines(quick.say, { now: () => 0 });
    quickLines.progress('quick');
    quickLines.done('ended');
    expect(quick.said).toEqual([]);
  });
});

describe('sayWhileRunning', () => {
  it('says the line every WAIT_LINE_EVERY_MS while the work runs, then the done line, and nothing after', async () => {
    vi.useFakeTimers();
    const { said, say } = recorder();
    let finish: (value: string) => void = () => {};
    const running = sayWhileRunning(new Promise<string>((resolve) => { finish = resolve; }), provingLine, say, { done: (result, elapsedMs) => `${result} after ${Math.round(elapsedMs / 1000)} s` });
    await vi.advanceTimersByTimeAsync(2 * WAIT_LINE_EVERY_MS + 1_000);
    finish('proven');
    expect(await running).toBe('proven');
    await vi.advanceTimersByTimeAsync(2 * WAIT_LINE_EVERY_MS);
    expect(said).toEqual([
      ['Proving the transaction: 15 s so far...', false],
      ['Proving the transaction: 30 s so far...', false],
      ['proven after 31 s', false],
    ]);
  });

  it('says nothing for work quicker than WAIT_LINE_EVERY_MS, not even its end; a failure is thrown as it is', async () => {
    vi.useFakeTimers();
    const { said, say } = recorder();
    expect(await sayWhileRunning(Promise.resolve(1), provingLine, say, { done: () => 'done' })).toBe(1);
    const failure = new Error('proof server gone');
    const failing = sayWhileRunning(new Promise((_, reject) => setTimeout(() => reject(failure), WAIT_LINE_EVERY_MS + 1)), provingLine, say, { done: () => 'done' });
    const caught = failing.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(WAIT_LINE_EVERY_MS + 1);
    expect(await caught).toBe(failure);
    expect(said).toEqual([['Proving the transaction: 15 s so far...', false]]);
  });
});

describe('eventsReadLine', () => {
  // Regression: "Reading shielded events... 1076 (to event 17009)" stopped at
  // about 6% while the read was done: 1076 shielded events among ids to 17009.
  it('says where a read is by the event id it reached, so a read caught up says 100%', () => {
    expect(eventsReadLine('shielded', { read: 1076, lastId: 17009, maxId: 17009, firstId: 0 })).toBe('Reading shielded events: at event 17009 of 17009 (100%), 1076 read');
    expect(eventsReadLine('shielded', { read: 540, lastId: 8504, maxId: 17009, firstId: 0 })).toBe('Reading shielded events: at event 8504 of 17009 (50%), 540 read');
  });

  it('counts from where a resumed read began', () => {
    expect(eventsReadLine('Dust', { read: 10, lastId: 1059, maxId: 1099, firstId: 1000 })).toBe('Reading Dust events: at event 1059 of 1099 (60%), 10 read');
  });

  it('gives the count alone when the reader reports no position (the native Dust reader) or the indexer has not said its last', () => {
    expect(eventsReadLine('Dust', { read: 120_000, maxId: 1_630_132, firstId: 0 })).toBe('Reading Dust events: 120000 read, of ids up to 1630132');
    expect(eventsReadLine('shielded', { read: 0, maxId: -1, firstId: 0 })).toBe('Reading shielded events: 0 read');
  });
});

describe('eventsReadDoneLine', () => {
  it('says the event a read reached, or that it stopped short and resumes there', () => {
    const progress = { read: 1076, lastId: 17009, maxId: 17009, firstId: 0 };
    expect(eventsReadDoneLine('shielded', { partial: false, lastAppliedEventId: 17009 }, progress, 212_000)).toBe('Shielded events read: to event 17009, 1076 read in 212 s');
    expect(eventsReadDoneLine('shielded', { partial: true, lastAppliedEventId: 9000 }, progress)).toBe('Shielded events: stopped at event 9000 of 17009; the next run resumes there');
  });
});
