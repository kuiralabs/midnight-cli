// Each public package's API report is the API its code has: a change to an
// export fails here until `node scripts/api-report.mjs write` writes the report
// again, so the change shows in review.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PACKAGES, apiReport, reportPath } from '../../scripts/api-report.mjs';

describe('the API reports', () => {
  it.each([...PUBLIC_PACKAGES])('%s: the checked-in report is the code\'s API', (dir) => {
    expect(readFileSync(reportPath(dir), 'utf8'), 'run node scripts/api-report.mjs write and review the diff').toBe(apiReport(dir));
  }, 120_000);
});
