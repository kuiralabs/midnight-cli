// Durations in words, for messages that say how long something will take.

/** A wait in words: "about 29 seconds", "about 19 minutes", "about 3 hours". */
export function formatWait(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    return `about ${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 2) return 'about a minute';
  if (minutes < 120) return `about ${minutes} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
}
