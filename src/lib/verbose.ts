// Verbose diagnostics: the timestamped line a call shows when it runs with
// --verbose / -v. Whether a call is verbose, and where its lines go, is the
// call's own (its context's diagnostics, 2F): a library that has diagnostics
// to give is handed the call's `line` as a VerboseLog, never a switch.

import { dim } from '../ui/colors.ts';

/** Where a call's verbose diagnostic lines go: its diagnostics' line, shown only when the call is verbose. */
export type VerboseLog = (phase: string, message: string) => void;

/** A verbose diagnostic line as shown: dimmed, with the time (HH:mm:ss.SSS) and the phase. */
export function verboseLine(phase: string, message: string): string {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  return dim(`  [${ts}] ${phase}: ${message}`);
}
