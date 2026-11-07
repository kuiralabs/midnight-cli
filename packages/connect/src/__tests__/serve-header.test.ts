// mn serve's header: each value stands apart from its key, all lined up.

import { describe, it, expect } from 'vitest';
import { describeApprovalPolicy } from '@kuiralabs/midnight-cli-core';
import { DEFAULT_FEE_LIMITS } from '@kuiralabs/midnight-cli-core/engine';
import { serveHeaderLines } from '../lib/serve-header.ts';

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

describe('serveHeaderLines', () => {
  // Regression: the key was longer than keyValue's default width, so it read "Auto-approve balancing:no".
  it('separates every key from its value and lines the values up', () => {
    const lines = serveHeaderLines({ network: 'undeployed', address: 'mn_addr_undeployed1x', port: 9932 }, describeApprovalPolicy({ approveFees: true }, DEFAULT_FEE_LIMITS), DEFAULT_FEE_LIMITS).map(strip);
    expect(lines.find((l) => l.includes('Auto-approve balancing'))).toMatch(/Auto-approve balancing: +fee-only/);
    const columns = new Set(lines.map((line) => line.search(/:\s+\S/) + line.slice(line.indexOf(':') + 1).search(/\S/) + 1));
    expect(columns.size).toBe(1);
    expect(lines.map((l) => l.trim().split(':')[0])).toEqual(['Network', 'Address', 'Port', 'Auto-approve balancing', 'Auto-approve writes', 'Fee limits']);
  });

  it('says no for what prompts, and leaves fee limits out without --approve-fees', () => {
    const lines = serveHeaderLines({ network: 'undeployed', address: 'a', port: 1 }, describeApprovalPolicy({}, DEFAULT_FEE_LIMITS), DEFAULT_FEE_LIMITS).map(strip);
    expect(lines.find((l) => l.includes('balancing'))).toMatch(/: +no$/);
    expect(lines.some((l) => l.includes('Fee limits'))).toBe(false);
  });
});
