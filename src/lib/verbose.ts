// Verbose logger: timestamped diagnostic lines, sent as notices (the shell
// writes them to stderr, so stdout stays pipeable). Enabled per-command via
// --verbose / -v flag.

import { dim } from '../ui/colors.ts';
import { notice } from './notices.ts';

let enabled = false;

export function enableVerbose(): void {
  enabled = true;
}

/** A verbose diagnostic line as shown: dimmed, with the time (HH:mm:ss.SSS) and the phase. */
export function verboseLine(phase: string, message: string): string {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  return dim(`  [${ts}] ${phase}: ${message}`);
}

/**
 * Send a verbose diagnostic line as a notice.
 * No-op when verbose mode is disabled.
 */
export function verbose(phase: string, message: string): void {
  if (!enabled) return;
  notice(verboseLine(phase, message));
}
