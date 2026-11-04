// mn as a release publishes it, packed into a folder: the workspace packages
// mn depends on (each engine with its shrinkwrap, each with the manifest it is
// published with: scripts/publish-manifest.mjs), and mn with the shrinkwrap
// the release job writes, its workspace packages' tarballs and integrity as a
// local registry on `port` serves them (scripts/local-registry.mjs). Until those packages are on npm, a
// consumer's npm finds them nowhere else, and npm honours mn's shrinkwrap only
// when its registry says the package has one; so the folder is installed
// through a local registry on the same port, wherever that runs:
//
//   node scripts/local-registry.mjs <dir> <port>
//   npm install -g --registry http://127.0.0.1:<port> midnight-wallet-cli@<version>
//
//   node scripts/pack-release.mjs <dir> [--port <port>]      (after `npm run build`)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalRegistryProcess } from './local-registry.mjs';
import { makeShrinkwrap, registryDist } from './make-shrinkwrap.mjs';
import { packPublished } from './publish-manifest.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Packs the release into `dir` for a registry on `port` (0: any free one),
 * leaving that registry running; resolves to it, mn's name and version, and
 * the workspace packages packed.
 */
export async function packRelease(dir, port = 0) {
  mkdirSync(dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8'));
  const workspaces = manifest.workspaces
    .map((folder) => {
      const { name, version } = JSON.parse(readFileSync(join(repo, folder, 'package.json'), 'utf-8'));
      return { folder, name, version };
    })
    .filter(({ name }) => manifest.dependencies[name] !== undefined);
  // Each engine with the shrinkwrap the release job writes for it.
  for (const { folder, name } of workspaces) {
    const engine = name.startsWith('@kuiralabs/midnight-engine-');
    if (engine) makeShrinkwrap({ dir: folder });
    try {
      packPublished(join(repo, folder), dir);
    } finally {
      if (engine) rmSync(join(repo, folder, 'npm-shrinkwrap.json'), { force: true });
    }
  }
  const registry = await startLocalRegistryProcess(dir, port);

  const shrinkwrapPath = join(repo, 'npm-shrinkwrap.json');
  try {
    makeShrinkwrap({ dist: registryDist(registry.url), out: shrinkwrapPath });
    run('npm', ['pack', '--pack-destination', dir], repo);
  } catch (error) {
    await registry.close();
    throw error;
  } finally {
    rmSync(shrinkwrapPath, { force: true });
  }
  return { registry, name: manifest.name, version: manifest.version, workspaces };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  const at = process.argv.indexOf('--port');
  if (!dir) {
    console.error('usage: node scripts/pack-release.mjs <dir> [--port <port>]');
    process.exit(2);
  }
  const { registry, name, version } = await packRelease(resolve(dir), at === -1 ? 0 : Number(process.argv[at + 1]));
  await registry.close();
  console.log(`packed ${name}@${version} into ${resolve(dir)}, for a registry on ${registry.url}`);
}
