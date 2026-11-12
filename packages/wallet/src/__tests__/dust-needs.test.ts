// What `dust register` says its Dust is ready for: the regression was a
// register that said "Dust tokens available: 0.197 DUST" and a transfer 15 s
// later refused for 0.65 DUST, with nothing saying when there would be enough.

import { describe, it, expect } from 'vitest';
import { COUNTER_DEPLOY_DUST } from '@kuiralabs/midnight-cli-core';
import { dustNeedsJson, dustNeedsText } from '../ui/dust-needs.ts';

const READINESS = {
  have: 197_000_000_000_000n,
  perSecond: 8_300_000_000_000n,
  transfer: { needs: 650_000_000_000_000n, waitMs: 55_000 },
  counterDeploy: { needs: COUNTER_DEPLOY_DUST, waitMs: 126_000 },
};

describe('dust needs', () => {
  it('says what a transfer and a counter deploy take and when the wallet has it', () => {
    expect(dustNeedsText(READINESS)).toEqual([
      'A transfer takes about 0.65 DUST: this wallet has it in about 55 seconds.',
      "A counter contract's deploy takes about 1.24 DUST: this wallet has it in about 3 minutes. Price yours: midnight contract deploy --dry-run.",
      'Its registered NIGHT generates 0.008300 DUST a second.',
    ]);
  });

  it('gives it to --json in DUST and whole seconds: 0 when the wallet has it, null when not within a day', () => {
    expect(dustNeedsJson(READINESS)).toEqual({
      generatedPerSecond: '0.008300',
      transfer: { dust: '0.650000', waitSeconds: 55 },
      counterDeploy: { dust: '1.240000', waitSeconds: 126 },
    });
    const ready = { ...READINESS, transfer: { ...READINESS.transfer, waitMs: 0 }, counterDeploy: { ...READINESS.counterDeploy, waitMs: null } };
    expect(dustNeedsJson(ready)).toMatchObject({ transfer: { waitSeconds: 0 }, counterDeploy: { waitSeconds: null } });
    expect(dustNeedsText(ready).slice(0, 2)).toEqual([
      'A transfer takes about 0.65 DUST: this wallet has it now.',
      "A counter contract's deploy takes about 1.24 DUST: its registered NIGHT won't generate it within a day (register more: midnight dust register). Price yours: midnight contract deploy --dry-run.",
    ]);
  });
});
