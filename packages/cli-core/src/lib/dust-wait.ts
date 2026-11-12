// Waiting for Dust to cover a fee. The Dust wallet's balance is a function of
// time (registered NIGHT keeps generating), so the wait can be found by
// looking ahead: 1000 NIGHT generates about 0.0083 DUST a second on a ledger-9
// local chain, so a wallet 0.2 DUST short of a fee waits about 24 seconds.

import { formatWait } from './duration.ts';
import { sleep } from './sleep.ts';
import { COUNTER_DEPLOY_DUST, DUST_RETRY_DELAY_MS, MIN_DUST_FOR_TRANSFER } from './constants.ts';
import { DustRequiredError } from './errors.ts';
import { dustShortfallOf } from './sdk-errors.ts';
import { roughDust, toDust } from '../ui/format.ts';
import type { WaitSink } from './notices.ts';
import { secondsText, WAIT_LINE_EVERY_MS } from './wait-lines.ts';

/** What the check reads from the SDK's Dust state. */
export interface DustBalanceSource {
  balance(at: Date): bigint;
}

/** Waits up to this long rather than refusing. */
export const DUST_SHORT_WAIT_MS = 2 * 60_000;
/**
 * How long a serve that mn starts for one of its own commands waits (contract
 * deploy and call, a test suite, grant): the person who ran the command sees
 * the wait and can stop it, and five minutes covers a 1000 NIGHT wallet's
 * next fee after it paid one (a counter deploy's fee was 1.08 DUST on a
 * ledger-9 local chain, 1.23 with the wallet's 3 blocks of margin, generated
 * in about two minutes).
 */
export const OWN_COMMAND_DUST_WAIT_MS = 5 * 60_000;
/** How far ahead a wait is looked for: past it, the wallet's NIGHT won't generate the Dust in useful time. */
export const LOOK_AHEAD_MS = 24 * 3_600_000;

/** Milliseconds until the balance reaches `needed`, in whole seconds: 0 if it already has, null if not within `horizonMs`. */
export function msUntilDust(dust: DustBalanceSource, needed: bigint, now: Date, horizonMs: number): number | null {
  const at = (seconds: number) => dust.balance(new Date(now.getTime() + seconds * 1000));
  if (at(0) >= needed) return 0;
  let high = Math.ceil(horizonMs / 1000);
  if (at(high) < needed) return null;
  let low = 0;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (at(mid) >= needed) high = mid; else low = mid;
  }
  return high * 1000;
}

/** An amount of Dust a payment takes, and how long until the wallet has it: 0 when it has, null when not within a day. */
export interface DustNeed {
  readonly needs: bigint;
  readonly waitMs: number | null;
}

/** What a wallet's Dust is ready for: a NIGHT transfer and a counter contract's deploy, and how fast its NIGHT generates more. */
export interface DustReadiness {
  /** What the wallet has now, in Specks. */
  readonly have: bigint;
  /** What its registered NIGHT generates a second now, in Specks (0 once its Dust is at its cap). */
  readonly perSecond: bigint;
  /** A NIGHT transfer: MIN_DUST_FOR_TRANSFER, what a one-recipient transfer commits to its fee with mn's margin. */
  readonly transfer: DustNeed;
  /** A counter contract's deploy: COUNTER_DEPLOY_DUST, a guide to a small contract's (a deploy is priced by `mn contract deploy --dry-run`). */
  readonly counterDeploy: DustNeed;
}

/**
 * What the Dust in `dust` (its balance as a function of time: a wallet's
 * registered NIGHT keeps generating) is ready for at `now`: right after a
 * registration a wallet has a fraction of a transfer's fee, and this says when
 * it has the rest.
 */
export function dustReadiness(dust: DustBalanceSource, now: Date = new Date()): DustReadiness {
  const need = (needs: bigint): DustNeed => ({ needs, waitMs: msUntilDust(dust, needs, now, LOOK_AHEAD_MS) });
  const have = dust.balance(now);
  const MINUTE_MS = 60_000;
  const perSecond = (dust.balance(new Date(now.getTime() + MINUTE_MS)) - have) / 60n;
  return { have, perSecond: perSecond > 0n ? perSecond : 0n, transfer: need(MIN_DUST_FOR_TRANSFER), counterDeploy: need(COUNTER_DEPLOY_DUST) };
}

/** Not enough Dust for the fee, with how long until there is. */
/** Another transaction from the same wallet (another mn, or mn serve) holds the Dust it spends until it is final: mn has no per-wallet lock, so it says so. */
const HELD_BY_ANOTHER = 'If another transaction from this wallet is running (another mn, or mn serve), it holds the Dust it spends until it is final: let it finish, then retry.';

export function dustShortError(have: bigint, needed: bigint, waitMs: number | null): DustRequiredError {
  const when = waitMs === null
    ? "This wallet's registered NIGHT won't generate that within a day: register more NIGHT (midnight dust register)."
    : `This wallet's NIGHT generates that in ${formatWait(waitMs)}; retry then.`;
  return new DustRequiredError(`Insufficient dust for transaction fees.\nAvailable: ${toDust(have)} DUST, need ≥${toDust(needed)} DUST.\n${when}\n${HELD_BY_ANOTHER}`);
}

/**
 * Make sure the Dust balance covers `needed`: return at once when it does,
 * wait when it will within DUST_SHORT_WAIT_MS (reporting how long, and on
 * `say` the wait's lines: waitForDustGrowth), and throw dustShortError
 * otherwise. A wallet with no Dust at all is left to the registration path
 * (returns at once).
 */
export async function awaitDustForFee(
  dust: DustBalanceSource,
  needed: bigint,
  onStatus?: (status: string) => void,
  signal?: AbortSignal,
  say?: WaitSink,
): Promise<void> {
  const now = new Date();
  const have = dust.balance(now);
  if (have === 0n || have >= needed) return;
  const waitMs = msUntilDust(dust, needed, now, LOOK_AHEAD_MS);
  if (waitMs === null || waitMs > DUST_SHORT_WAIT_MS) throw dustShortError(have, needed, waitMs);
  onStatus?.(`Waiting ${formatWait(waitMs)} for Dust to cover the fee (${toDust(have)} of ${toDust(needed)} DUST)...`);
  if (say === undefined) await sleep(waitMs, signal);
  else await waitForDustGrowth({ have, needed, waitMs }, dust, say, { signal });
}

/** How often a wait for Dust says how far it is (WAIT_LINE_EVERY_MS, as every long step). */
export const DUST_WAIT_REPORT_MS = WAIT_LINE_EVERY_MS;

/** Whole seconds, for a wait's lines: "89 s". */
const seconds = secondsText;

/** A wait's opening line: what the wallet has, what the fee takes, how long its NIGHT takes to generate the rest. */
export function dustWaitOpening(have: bigint, needed: bigint, waitMs: number): string {
  return `Dust: ${roughDust(have)} of the ${roughDust(needed, true)} DUST this fee takes; waiting ${formatWait(waitMs)} (${seconds(waitMs)}) for its registered NIGHT to generate the rest...`;
}

/** A line of a wait under way: the time waited of the whole, and the Dust the wallet has now of what the fee takes. */
export function dustWaitProgress(waitedMs: number, waitMs: number, have: bigint, needed: bigint): string {
  return `Dust: waited ${seconds(waitedMs)} of ${seconds(waitMs)}, ${roughDust(have)} of ${roughDust(needed, true)} DUST`;
}

/**
 * Waits `waitMs` for the wallet's NIGHT to generate the Dust a fee takes,
 * saying so on `say`: the opening line first (`opening` true), then every
 * `everyMs` the time waited and the Dust the wallet has by then (`have`
 * plus what `dust` grew since the wait began). Nothing is said at the end:
 * the payment goes on.
 */
export async function waitForDustGrowth(
  plan: { have: bigint; needed: bigint; waitMs: number },
  dust: DustBalanceSource,
  say: (line: string, opening: boolean) => void,
  options: { everyMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const { have, needed, waitMs } = plan;
  const everyMs = options.everyMs ?? DUST_WAIT_REPORT_MS;
  const started = Date.now();
  const startBalance = dust.balance(new Date(started));
  say(dustWaitOpening(have, needed, waitMs), true);
  for (;;) {
    const left = waitMs - (Date.now() - started);
    if (left <= 0) return;
    await sleep(Math.min(everyMs, left), options.signal);
    const now = Date.now();
    if (now - started >= waitMs) return;
    const grown = dust.balance(new Date(now)) - startBalance;
    say(dustWaitProgress(now - started, waitMs, have + (grown > 0n ? grown : 0n), needed), false);
  }
}

/** A fee the wallet's Dust doesn't cover yet: what it has, what the fee takes, and how long its NIGHT needs for the rest (null: not within a day). */
export interface DustWaitPlan {
  have: bigint;
  needed: bigint;
  waitMs: number | null;
}

/**
 * The wait for a Dust shortage that says what the wallet is short by (mn's
 * fee planner marks its shortages so): how long the balance takes to grow by
 * that much. The shortfall is measured on the wallet's clock for the chain,
 * which needn't be this machine's, so it is the growth that is timed, not a
 * balance to reach. Undefined when the error carries no shortfall.
 */
export function planDustWait(err: unknown, dust: DustBalanceSource, now: Date): DustWaitPlan | undefined {
  const shortfall = dustShortfallOf(err);
  if (!shortfall || shortfall.available >= shortfall.needed) return undefined;
  const { needed, available: have } = shortfall;
  // A little over the shortfall, and never a wait too short to matter: the
  // fee is worked out again at the next attempt and moves by a few parts in
  // a thousand, which would otherwise be a string of one-second waits.
  const target = dust.balance(now) + (needed - have) * 102n / 100n;
  const waitMs = msUntilDust(dust, target, now, LOOK_AHEAD_MS);
  return { have, needed, waitMs: waitMs === null ? null : Math.max(waitMs, DUST_RETRY_DELAY_MS) };
}

/**
 * Run `pay`, a wallet call that pays a fee. When it fails because the Dust
 * doesn't cover the fee yet, wait for the wallet's NIGHT to generate the rest
 * and run it again: for as long as the waits fit in `maxWaitMs`, reporting
 * each; past that, dustShortError with the time. Any other failure is thrown
 * as it is.
 */
export async function payWhenDustCovers<T>(
  pay: () => Promise<T>,
  dust: DustBalanceSource,
  options: { maxWaitMs: number; onStatus?: (status: string) => void; signal?: AbortSignal; /** Where each wait's lines go (waitForDustGrowth), in every mode. */ say?: WaitSink },
): Promise<T> {
  let waitedMs = 0;
  for (;;) {
    try {
      return await pay();
    } catch (err) {
      const plan = planDustWait(err, dust, new Date());
      if (!plan) throw err;
      if (plan.waitMs === null || waitedMs + plan.waitMs > options.maxWaitMs) throw dustShortError(plan.have, plan.needed, plan.waitMs);
      options.onStatus?.(`Waiting ${formatWait(plan.waitMs)} for Dust to cover the fee (${roughDust(plan.have)} of ${roughDust(plan.needed, true)} DUST)...`);
      if (options.say === undefined) await sleep(plan.waitMs, options.signal);
      else await waitForDustGrowth({ have: plan.have, needed: plan.needed, waitMs: plan.waitMs }, dust, options.say, { signal: options.signal });
      waitedMs += plan.waitMs;
    }
  }
}

// The wait the Dust loops use, cut short by the call's cancellation; it lives in sleep.ts, which other waits share.
export { sleep };
