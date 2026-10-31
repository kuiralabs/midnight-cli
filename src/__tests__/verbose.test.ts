import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reset module state between tests by re-importing. Verbose lines go out as
// notices; the CLI's sink writes them to stderr.
let verbose: typeof import('../lib/verbose.ts');
let lines: string[];

beforeEach(async () => {
  // Fresh import to reset `enabled` state
  vi.resetModules();
  verbose = await import('../lib/verbose.ts');
  lines = [];
  (await import('../lib/notices.ts')).setNoticeSink((line) => lines.push(line));
});

afterEach(async () => {
  (await import('../lib/notices.ts')).setNoticeSink(null);
});

describe('verbose', () => {
  it('is a no-op when not enabled', () => {
    verbose.verbose('test', 'hello');
    expect(lines).toEqual([]);
  });

  it('sends a notice when enabled', () => {
    verbose.enableVerbose();
    verbose.verbose('sync', 'Starting facade...');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sync');
    expect(lines[0]).toContain('Starting facade...');
  });

  it('includes timestamp in HH:mm:ss.SSS format', () => {
    verbose.enableVerbose();
    verbose.verbose('phase', 'msg');

    // Timestamp pattern: [HH:mm:ss.SSS]
    expect(lines[0]).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
  });

  it('includes phase and message in output', () => {
    verbose.enableVerbose();
    verbose.verbose('facade', 'Node: wss://example.com');

    expect(lines[0]).toContain('facade: Node: wss://example.com');
  });

  it('sends one line per message, which the sink ends', () => {
    verbose.enableVerbose();
    verbose.verbose('test', 'msg');

    expect(lines[0]).not.toContain('\n');
  });
});
