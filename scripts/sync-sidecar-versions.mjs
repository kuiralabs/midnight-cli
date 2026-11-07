// Pin mn's `optionalDependencies` to the per-platform dust-sync packages, at
// their version exactly. The platform packages move with the other @kuiralabs
// workspace packages (0.1.0-rc.N), not with mn; they all carry one version, so
// every platform gets a binary built from the same ledger crates. The CLI must
// load only a sidecar built from those crates, so the pins are exact, never a
// caret range. Run in CI before publishing (the release workflow does), or by
// hand to check.
//
//   node scripts/sync-sidecar-versions.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));

const platforms = readdirSync('packages')
  .filter((dir) => dir.startsWith('dust-sync-'))
  .map((dir) => JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8')));
const versions = [...new Set(platforms.map((manifest) => manifest.version))];
if (versions.length !== 1) {
  console.error(`The dust-sync platform packages carry different versions (${versions.join(', ')}); give them one.`);
  process.exit(1);
}

// Entries for platform packages of an earlier name or scope are dropped.
const optionalDependencies = Object.fromEntries(
  Object.entries(root.optionalDependencies ?? {}).filter(([name]) => !/\/dust-sync-/.test(name)),
);
for (const manifest of platforms) optionalDependencies[manifest.name] = manifest.version; // exact pin

root.optionalDependencies = optionalDependencies;
writeFileSync('package.json', JSON.stringify(root, null, 2) + '\n');
console.log(`Pinned ${platforms.length} dust-sync platform package(s) in optionalDependencies at ${versions[0]}`);
