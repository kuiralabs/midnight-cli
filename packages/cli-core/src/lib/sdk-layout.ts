// Whether an engine's install holds its SDK set once. An engine's ledger is
// WASM: an object one copy made is refused by another ("expected instance of
// LedgerParameters"). npm installs mn with the shrinkwrap it ships, which holds
// the engine's set once; an installer that ignores it (bun's) can leave an
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

/** One dependency that resolves to another version than the engine's shrinkwrap gives it. */
export interface TreeDrift {
  /** The package that depends on it, as the shrinkwrap names its place ('.' for the engine). */
  readonly from: string;
  readonly name: string;
  /** The version Node resolves from where `from` sits, or null when it finds none. */
  readonly found: string | null;
  readonly shipped: string;
}

/** An engine's installed tree isn't the one its shrinkwrap describes: an installer resolved its ranges again. */
export class NotInstalledAsShippedError extends Error {
  readonly code = 'MIXED_SDK_LAYOUT';
  readonly drift: readonly TreeDrift[];
  constructor(engine: string, drift: readonly TreeDrift[]) {
    const first = drift[0]!;
    super(
      `${engine} isn't installed as it was tested: ${drift.length} of its dependencies resolve to other versions than the npm-shrinkwrap.json it ships ` +
      `(${first.name} ${first.found ?? 'missing'} where ${first.shipped} was tested, for ${first.from}), so it could fail in ways nobody has seen. ` +
      'This happens with an installer that ignores the shrinkwrap, such as bun\'s or npm 12 and later. ' +
      'Install with npm 11 or older (npm install -g midnight-wallet-cli for mn, or npm install for a program; with npm 12, npx -y npm@11 install …); bun can run what npm installed.',
    );
    this.name = 'NotInstalledAsShippedError';
    this.drift = drift;
  }
}

interface ShrinkwrapEntry {
  readonly version?: string;
  readonly optional?: boolean;
  readonly dev?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

/**
 * The dependencies of the engine at `engineDir` that resolve to other versions
 * than its shipped `npm-shrinkwrap.json` gives them; null when it ships none
 * (a workspace checkout). The dependency graph is walked from the engine: each
 * dependency is resolved as Node resolves it, from where the package that
 * needs it really sits, and compared with the version the shrinkwrap places
 * for that package. So a tree npm nests and one it hoists both pass, and one
 * an installer built from the ranges again fails.
 */
export function shippedTreeDrift(engineDir: string): TreeDrift[] | null {
  const shrinkwrap = join(engineDir, 'npm-shrinkwrap.json');
  if (!existsSync(shrinkwrap)) return null;
  const entries = (JSON.parse(readFileSync(shrinkwrap, 'utf-8')) as { packages?: Record<string, ShrinkwrapEntry> }).packages ?? {};
  // Where the shrinkwrap places `name` for the package at `key`: the nearest node_modules above it that holds it.
  const placed = (key: string, name: string): string | undefined => {
    for (let at = key; ; ) {
      const candidate = `${at === '' ? '' : `${at}/`}node_modules/${name}`;
      if (entries[candidate] !== undefined) return candidate;
      if (at === '') return undefined;
      const parent = at.lastIndexOf('/node_modules/');
      at = parent < 0 ? '' : at.slice(0, parent);
    }
  };
  const versionAt = (dir: string): string | null => {
    try { return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { version?: string }).version ?? null; } catch { return null; }
  };
  const drift: TreeDrift[] = [];
  const seen = new Set<string>();
  const todo: [key: string, dir: string][] = [['', realpathSync(engineDir)]];
  while (todo.length > 0) {
    const [key, dir] = todo.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const entry = entries[key] ?? {};
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      const shippedKey = placed(key, name);
      const shipped = shippedKey === undefined ? undefined : entries[shippedKey];
      if (shippedKey === undefined || shipped?.version === undefined || shipped.dev === true) continue;
      const found = resolvedPackageFolder(dir, name);
      if (found === null) {
        if (shipped.optional !== true) drift.push({ from: key === '' ? '.' : key, name, found: null, shipped: shipped.version });
        continue;
      }
      const version = versionAt(found);
      if (version !== shipped.version) drift.push({ from: key === '' ? '.' : key, name, found: version, shipped: shipped.version });
      else todo.push([shippedKey, found]);
    }
  }
  return drift;
}

/** Throws NotInstalledAsShippedError when the engine at `engineDir` ships a shrinkwrap its install doesn't match. */
export function assertInstalledAsShipped(engine: string, engineDir: string): void {
  const drift = shippedTreeDrift(engineDir);
  if (drift !== null && drift.length > 0) throw new NotInstalledAsShippedError(engine, drift);
}
