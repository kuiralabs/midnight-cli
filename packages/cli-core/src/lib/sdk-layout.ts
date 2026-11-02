// Whether an engine's install holds its SDK set once. An engine's ledger is
// WASM: an object one copy made is refused by another ("expected instance of
// LedgerParameters"). npm installs mn with the shrinkwrap it ships, which keeps
// each engine's set apart; an installer that ignores it (bun's) can leave an
// engine's SDK packages reaching different copies of its ledger, and every
// call would then fail obscurely. An engine checks at load and refuses,
// saying how to install mn instead.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The folder of the package `name` that Node resolves from `from`, or null. */
export function resolvedPackageFolder(from: string, name: string): string | null {
  for (let at = from; ; at = dirname(at)) {
    const manifest = join(at, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) return realpathSync(dirname(manifest));
    if (dirname(at) === at) return null;
  }
}

/** An engine's SDK packages reach more than one copy of a WASM package. */
export class MixedSdkLayoutError extends Error {
  readonly code = 'MIXED_SDK_LAYOUT';
  constructor(engine: string, wasmPackage: string, copies: string[]) {
    super(
      `${engine}'s SDK packages reach ${copies.length} copies of ${wasmPackage} (${copies.join(', ')}), so its calls would fail. ` +
      'This happens when mn is installed without the shrinkwrap it ships (bun\'s installer ignores it). ' +
      'Install mn with npm: npm install -g midnight-wallet-cli',
    );
    this.name = 'MixedSdkLayoutError';
  }
}

/**
 * Throws MixedSdkLayoutError unless every package in `packages`, resolved from
 * `engineDir`, reaches the same copy of each of `wasmPackages` the engine
 * itself does.
 */
export function assertOneSdkCopy(engine: string, engineDir: string, packages: readonly string[], wasmPackages: readonly string[]): void {
  const holders = [engineDir, ...packages.map((name) => resolvedPackageFolder(engineDir, name)).filter((dir): dir is string => dir !== null)];
  for (const wasm of wasmPackages) {
    const copies = new Set<string>();
    for (const holder of holders) {
      // A package that doesn't use this WASM package reaches none, which is no copy.
      const declares = holder === engineDir || dependsOn(holder, wasm);
      if (!declares) continue;
      const copy = resolvedPackageFolder(holder, wasm);
      if (copy !== null) copies.add(copy);
    }
    if (copies.size > 1) throw new MixedSdkLayoutError(engine, wasm, [...copies]);
  }
}

function dependsOn(packageDir: string, name: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    return manifest.dependencies?.[name] !== undefined || manifest.peerDependencies?.[name] !== undefined;
  } catch {
    return false;
  }
}
