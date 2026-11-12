// The lines a long step says on a host's `waiting` (Host.waiting), which a
// host shows in every mode: a --json run, a pipe and the MCP server's log hear
// what a terminal's spinner shows, so minutes of work never look like a hang.
// A step says nothing for its first WAIT_LINE_EVERY_MS, so a quick one stays
// quiet; past that, where it is, once every WAIT_LINE_EVERY_MS at most.

import type { WaitSink } from './notices.ts';

/** How often a long step says where it is: often enough that minutes never look like a hang, seldom enough for a log. */
export const WAIT_LINE_EVERY_MS = 15_000;

/** Whole seconds, as a wait's lines give them: "45 s". */
export const secondsText = (ms: number): string => `${Math.round(ms / 1000)} s`;

/** A step that reports its progress as it goes: what it says, when a line is due. */
export interface StepLines {
  /** Where the step is now: said once WAIT_LINE_EVERY_MS has passed since the step began or since its last line. */
  progress(line: string): void;
  /** The step is over: `line` is said when the step said anything before, so a step heard under way is heard to end. */
  done(line: string): void;
}

/** Lines of a step that begins now, said on `say` as lines of a wait under way (not an opening). */
export function stepLines(say: WaitSink, options: { everyMs?: number; now?: () => number } = {}): StepLines {
  const everyMs = options.everyMs ?? WAIT_LINE_EVERY_MS;
  const now = options.now ?? Date.now;
  let due = now() + everyMs;
  let said = false;
  return {
    progress(line) {
      const at = now();
      if (at < due) return;
      due = at + everyMs;
      said = true;
      say(line, false);
    },
    done(line) {
      if (said) say(line, false);
      said = false;
      due = Number.POSITIVE_INFINITY;
    },
  };
}

/**
 * Waits for `work`, saying `line(elapsedMs)` on `say` every WAIT_LINE_EVERY_MS
 * while it runs (nothing when it ends sooner): a proof, or a read whose line
 * says where it is now. When it said anything and `work` succeeds, `done`'s
 * line ends it.
 */
export async function sayWhileRunning<T>(work: Promise<T>, line: (elapsedMs: number) => string, say: WaitSink, options: { everyMs?: number; done?: (result: T, elapsedMs: number) => string } = {}): Promise<T> {
  const everyMs = options.everyMs ?? WAIT_LINE_EVERY_MS;
  const started = Date.now();
  let said = false;
  const timer = setInterval(() => {
    said = true;
    say(line(Date.now() - started), false);
  }, everyMs);
  let result: T;
  try {
    result = await work;
  } finally {
    clearInterval(timer);
  }
  if (said && options.done !== undefined) say(options.done(result, Date.now() - started), false);
  return result;
}

/** Where a read of the indexer's ledger events is: events read, the id of the last, the indexer's last id, and the id the read began at. */
export interface EventReadProgress {
  readonly read: number;
  /** Unknown for a reader that reports only its count (the native Dust reader). */
  readonly lastId?: number;
  /** -1 until the indexer has said. */
  readonly maxId: number;
  readonly firstId: number;
}

/**
 * A read of `kind` events where it is. The indexer numbers the ledger's events
 * of every kind in one sequence (on preview, 62 shielded events between ids
 * 4709 and 4970), so a count of one kind is no fraction of the last id: the
 * progress is the id the read reached, from where it began to the indexer's
 * last, which a read caught up reaches.
 */
export function eventsReadLine(kind: string, { read, lastId, maxId, firstId }: EventReadProgress): string {
  if (maxId < 0) return `Reading ${kind} events: ${read} read`;
  if (lastId === undefined) return `Reading ${kind} events: ${read} read, of ids up to ${maxId}`;
  const span = maxId - firstId + 1;
  const percent = span <= 0 ? 100 : Math.max(0, Math.min(100, Math.floor(((lastId - firstId + 1) / span) * 100)));
  return `Reading ${kind} events: at event ${lastId} of ${maxId} (${percent}%), ${read} read`;
}

/**
 * What a read of `kind` events says at its end: to which event it read, or
 * that it stopped short of the indexer's last (the next run resumes there);
 * with the time it took when `elapsedMs` is given.
 */
export function eventsReadDoneLine(kind: string, result: { readonly partial: boolean; readonly lastAppliedEventId: number }, progress: EventReadProgress, elapsedMs?: number): string {
  const took = elapsedMs === undefined ? '' : ` in ${secondsText(elapsedMs)}`;
  const named = kind.charAt(0).toUpperCase() + kind.slice(1);
  if (result.partial) return `${named} events: stopped at event ${result.lastAppliedEventId} of ${progress.maxId}${took}; the next run resumes there`;
  return `${named} events read: to event ${result.lastAppliedEventId}, ${progress.read} read${took}`;
}

/** A proof's line while it runs. */
export const provingLine = (elapsedMs: number): string => `Proving the transaction: ${secondsText(elapsedMs)} so far...`;
