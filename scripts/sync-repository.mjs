// Copy the repository and issue links from the root package.json into every
// package under packages/, so the repository's address is written in one place.
// npm provenance checks each package's repository URL against the repository
// that publishes it, so a stale copy fails the release. Run after changing the
// root's `repository` or `bugs`; src/__tests__/package-metadata.test.ts fails
// until the copies match.
//
//   node scripts/sync-repository.mjs

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));

let synced = 0;
for (const dir of readdirSync('packages')) {
  const manifestPath = join('packages', dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.repository = { ...root.repository, directory: `packages/${dir}` };
  manifest.bugs = root.bugs;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  synced++;
}

console.log(`Synced the repository and issue links of ${synced} package(s) to ${root.repository.url}`);
