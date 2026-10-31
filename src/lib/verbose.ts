// Verbose logger: timestamped diagnostic lines, sent as notices (the shell
// writes them to stderr, so stdout stays pipeable). Enabled per-command via
// --verbose / -v flag.

import { dim } from '../ui/colors.ts';
import { notice } from './notices.ts';

let enabled = false;

export function enableVerbose(): void {
  enabled = true;
}

/**
 * Send a verbose diagnostic line as a notice.
 * No-op when verbose mode is disabled.
 */
export function verbose(phase: string, message: string): void {
  if (!enabled) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  notice(dim(`  [${ts}] ${phase}: ${message}`));
}
