// Writes each public package's table of codes into its README, between its
// markers, from the package's code definitions. A test fails when a README
// differs.
//
// Usage: npm run package-readmes

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_CODES, withPackageCodeTable } from '../src/lib/package-readmes.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const [dir, codes] of Object.entries(PACKAGE_CODES)) {
  const path = join(ROOT, 'packages', dir, 'README.md');
  writeFileSync(path, withPackageCodeTable(readFileSync(path, 'utf8'), dir, codes));
  process.stdout.write(`wrote packages/${dir}/README.md\n`);
}
