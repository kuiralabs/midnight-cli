import { describe, it, expect } from 'vitest';
import { verboseLine } from '../lib/verbose.ts';

// The verbose line's format. Whether a call shows it is the call's own
// (verbose-per-call.test.ts, call-context.test.ts).
describe('verboseLine', () => {
  it('includes timestamp in HH:mm:ss.SSS format', () => {
    expect(verboseLine('phase', 'msg')).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
  });

  it('includes phase and message', () => {
    const line = verboseLine('facade', 'Node: wss://example.com');
    expect(line).toContain('facade: Node: wss://example.com');
  });

  it('names the phase it is given', () => {
    const line = verboseLine('sync', 'Starting facade...');
    expect(line).toContain('sync');
    expect(line).toContain('Starting facade...');
  });

  it('is one line, which the sink ends', () => {
    expect(verboseLine('test', 'msg')).not.toContain('\n');
  });
});
