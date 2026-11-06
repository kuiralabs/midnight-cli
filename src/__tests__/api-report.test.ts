// Each public package's API report is the API its code has: a change to an
// export fails here until `node scripts/api-report.mjs write` writes the report
// again, so the change shows in review. Each report has a section for every
// entry point its package's exports map lists, and no other.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PACKAGES, apiReport, reportPath } from '../../scripts/api-report.mjs';

const PACKAGES = join(import.meta.dirname, '..', '..', 'packages');

describe('the API reports', () => {
  it.each([...PUBLIC_PACKAGES])('%s: the checked-in report is the code\'s API', (dir) => {
    expect(readFileSync(reportPath(dir), 'utf8'), 'run node scripts/api-report.mjs write and review the diff').toBe(apiReport(dir));
  }, 120_000);
});

describe("each API report's sections", () => {
  it.each([...PUBLIC_PACKAGES])('%s: one for each entry point', (dir) => {
    const { name, exports } = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as { name: string; exports: Record<string, unknown> };
    const sections = [...readFileSync(reportPath(dir), 'utf8').matchAll(/^## `([^`]+)`$/gm)].map((match) => match[1]);
    expect(sections.sort()).toStrictEqual(Object.keys(exports).map((subpath) => (subpath === '.' ? name : `${name}${subpath.slice(1)}`)).sort());
  });
});
