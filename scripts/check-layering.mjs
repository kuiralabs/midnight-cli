#!/usr/bin/env node
// Checks that src/ respects the package layering of the planned split: which
// future package each file belongs to, which packages it may import, and which
// external packages it may not. Every import counts, dynamic and type-only ones
// included, because each becomes a package dependency once the code is split.
//
// Libraries never call commands, and commands never call another package's
// commands: a command is an adapter over library functions, and only the shell
// and the MCP server dispatch to one. A package's codes file is data, not a
// command: a package below lends its sets of codes to the definitions above.
//
// Core's process code (packages/cli-core/src/process/, its "./process" entry
// point) is host-called: only the shell imports it, and no package source does,
// by name or by path; a host calls it on its own process.
//
// A workspace package is imported by its entry points only: an import of
// `@kuiralabs/<package>/<subpath>` resolves through that package's exports map,
// and a subpath the map lacks is a deep import, refused. An import of an entry
// point that is a barrel (only `export { … } from` lists) is judged by the
// modules defining the names it imports, so the rules above hold through it.
// Tests (`__tests__`) and scripts/*.{ts,mjs} are scanned too: a test imports
// its own package relatively and every other package by entry point; a script
// imports a package by entry point. A test of a package's internals lives in
// that package. test-support/ holds what tests of several packages share (the
// suites both engines run, the test host, stand-in servers); it is published
// with nothing. Any test may import it; it imports a package by entry point
// only, and of mn's own code only the shell's list of engines, which the test
// host makes its engines with.
//
// Usage: node scripts/check-layering.mjs
// Imported, it exports sourceFiles and homeOf: which package each file of src/ is in;
// importRule, guidanceRule and processCodeRule: the rule an import breaks; findLayeringProblems,
// which the suite runs, and testProblems, one test file's; importsOf and
// importedModules, a file's imports and the modules they bring in
// (scripts/code-reach.mjs walks them); and the workspace packages' entry
// points (entryPoints, entrySource). Exits 1 when a file has no package, or an import breaks a rule.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codeOnly, CORE_PROCESS_DIR } from './check-process-safety.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const SCRIPTS = join(ROOT, 'scripts');
const TEST_SUPPORT = join(ROOT, 'test-support');
const TEST_SUPPORT_MAY_IMPORT = [join(SRC, 'lib', 'installed-engines.ts')];

// Scripts the scan leaves out, each with why.
const UNSCANNED_SCRIPTS = {
};

// The layering check's own fixtures: test files that break the rules on
// purpose, which src/__tests__/layering.test.ts checks one by one.
const LAYERING_FIXTURES = join(SRC, '__tests__', 'fixtures', 'layering');

// The packages of the split, in the layering's order.
const PACKAGES = ['core', 'chain', 'wallet', 'contract', 'connect', 'dev', 'grant'];

// Which package a file belongs to: the first pattern that matches its path
// under src/ wins. A file that matches nothing fails the check.
const HOMES = [
  ['shell', /^wallet\.ts$/],
  // help plays the shell's intro, and manual builds the full manual; both render the installed registry.
  ['shell', /^commands\/(help|manual)(\.definition)?\.ts$/],
  // pkg reads mn's own package.json: its name, version and repository.
  ['shell', /^lib\/(pkg|heap-guard|node-version|intro-marker|output-redaction|cli-host|installed-commands|installed-engines|command-dispatch|agent-manual|readme-commands|package-readmes|code-tables|closed-reader)\.ts$/],
  ['shell', /^ui\/(animate|art)\.ts$/],
  ['mcp', /^mcp-server\.ts$/],
  ['mcp', /^lib\/mcp\//],

  // A package's agent guidance (<package>.guidance.ts), its error codes (<package>.codes.ts) and its registry entry (<package>.package.ts) sit beside its commands.
  ...PACKAGES.map((pkg) => [pkg, new RegExp(`^commands/${pkg}\\.(guidance|codes|package)\\.ts$`)]),

  // A command's definition (<name>.definition.ts) lives in its command's package.
  ['core', /^commands\/config(\.definition)?\.ts$/],
  // The SDK engines: each is the only code that imports its SDK set.
  ['engine', /^engine\//],

  ['core', /^lib\/(argv|errors|engine|exit-codes|json-output|constants|cli-config|network|network-id|resolve-network|payer|blockfrost|durable-file|keystore|verbose|error-trim|command-flags|run-command|phase-tracker|sdk-errors|amount|duration|sdk-warnings|notices|prompter|settings|state-root|command-definition|call-context|sleep|exec-program|agent-guidance|error-codes|wallet-cache|cache-indexer|reader-cache-files|connector-api|dust-wait|fee-limits|tx-serde|sign-data|approval|dust-balancing-plan|dust-registration-plan|shielded-policy|mainnet-refusal|wallet-session|sdk-layout|swap-offer|offer-envelope|open-offers|coin-picker|host|transport-failure|endpoint-unreachable|progress|network-target)\.ts$/],
  ['core', /^ui\/(colors|format|spinner|terminal-prompter)\.ts$/],
  // What a host calls on its own process: the SDK rejection guard, the sync heap advice.
  ['core', /^process\//],
  ['dev', /^ui\/(test-create-prompt|dev-keys)\.ts$/],

  ['chain', /^commands\/(status|tx)(\.definition)?\.ts$/],
  ['chain', /^lib\/(node-rpc|chain-id|indexer-graphql|graphql-ws-subscription|event-tip|ledger-guard|node-ready|indexer-ready|proof-server-ready|proof-failure|chain-clock|endpoint-check|balance-subscription|tx-segments|tx-status|tx-receipt|offer-liveness)\.ts$/],

  ['wallet', /^commands\/(wallet|generate|address|genesis-address|info|balance|transfer|airdrop|dust|cache)(\.definition)?\.ts$/],
  ['wallet', /^lib\/(derivation|derive-address|wallet-config|seed-resolver|passphrase|facade|wallet-data-repository|transfer|transfer-request|sync-eta|wallet-can-pay|wallet-create|airdrop|wallet-protector|chain-caches|wallet-paths|fork-schedule)\.ts$/],
  ['wallet', /^lib\/(dust-[a-z-]+|shielded-[a-z-]+)\.ts$/],
  ['wallet', /^lib\/wallet\//],
  ['wallet', /^ui\/receipt\.ts$/],
  // Swap is the wallet's: its offers are made, taken and cancelled by a wallet.
  ['wallet', /^commands\/swap(\.definition|\.guidance|\.package)?\.ts$/],
  ['wallet', /^lib\/swap\//],

  ['contract', /^commands\/(contract|inspect-cost)(\.definition)?\.ts$/],
  ['contract', /^lib\/contract\//],
  ['contract', /^lib\/chain-params\.ts$/],

  ['connect', /^commands\/serve(\.definition)?\.ts$/],
  ['connect', /^lib\/(dapp-connector|ws-rpc|sign-recipe|serve-manager|serve-payer)\.ts$/],

  ['dev', /^commands\/(dev|test|localnet)(\.definition)?\.ts$/],
  ['dev', /^lib\/localnet\.ts$/],
  ['dev', /^lib\/(dev|test)\//],

  ['grant', /^commands\/grant(\.definition)?\.ts$/],
  ['grant', /^lib\/grant\//],
];

// The packages each package may import, its own included. Dependencies point
// one way: core, chain, wallet, then contract and connect side by side, then
// dev, then grant. An engine sits beside chain: it uses core and chain, and
// nothing imports it but core's loader.
const MAY_IMPORT = {
  engine: ['core', 'chain', 'engine'],
  core: ['core'],
  chain: ['core', 'chain'],
  wallet: ['core', 'chain', 'wallet'],
  contract: ['core', 'chain', 'wallet', 'contract'],
  connect: ['core', 'chain', 'wallet', 'connect'],
  dev: ['core', 'chain', 'wallet', 'contract', 'connect', 'dev'],
  grant: ['core', 'chain', 'wallet', 'contract', 'connect', 'dev', 'grant'],
  // The shell installs every package's commands and guidance, picks the payer
  // and the protectors, and starts the MCP server.
  shell: [...PACKAGES, 'mcp', 'shell'],
  // The MCP server runs the registry the shell installs, through the shell's
  // host and runner, and pays through connect's serve payer. It reaches no
  // other package: every tool comes from the registry.
  mcp: ['core', 'connect', 'shell', 'mcp'],
};

// They dispatch to commands and assemble every package's guidance.
const DISPATCHERS = new Set(['shell', 'mcp']);

const MIDNIGHT_SDK = /^@midnight(-ntwrk|ntwrk)\//;

// The one module that may import an engine: the shell's list of the engines
// it ships, which the host installs as core's engine loader.
const ENGINE_LOADER = 'lib/installed-engines.ts';

// The account package (its Midnight libraries are peer dependencies) and the
// account library it is built on (no SDK). Grant drives the account; each
// engine installs the package over its own SDK set, and grant reaches its
// code through the network's engine, importing its types alone: a copy grant
// imported would resolve the package's libraries from grant's folder.
const ACCOUNT_CHAIN = /^@kuiralabs\/midnight-account-chain(\/|$)/;
const ACCOUNT_LIBRARY = /^@kuiralabs\/midnight-account(\/|$)/;

/** The rule an import of the account package or library from `home` breaks (`typeOnly`: an `import type`), or undefined. */
export function accountImportRule(home, specifier, typeOnly) {
  if (ACCOUNT_CHAIN.test(specifier)) {
    if (home === 'engine') return undefined;
    if (home === 'grant') return typeOnly ? undefined : "grant → account chain's code (grant reaches it through the network's engine, and imports its types alone)";
    return `${home} → account chain`;
  }
  if (ACCOUNT_LIBRARY.test(specifier) && home !== 'grant') return `${home} → account chain`;
  return undefined;
}

// The engine contract's reading of the SDK's and the node's errors: an engine
// turns them into typed errors, so only the engines read them, and in core
// only the wallet session (the DApp connector in a program's process) and the
// Dust wait (what a shortage says the wallet is short by).
const SDK_ERRORS = 'lib/sdk-errors.ts';
const SDK_ERROR_READERS = /^lib\/(sdk-errors|wallet-session|dust-wait)\.ts$/;

// import ... from 'x', export ... from 'x', import 'x', import('x').
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm;

// The workspace packages carved out of src/, each with its folder, its source
// folder and the home it is. A file's path in a package (lib/argv.ts) reads as
// it did under src/, so the homes and rules above apply to it unchanged.
export const WORKSPACE_PACKAGES = [
  { name: '@kuiralabs/midnight-cli-core', root: join(ROOT, 'packages', 'cli-core'), dir: join(ROOT, 'packages', 'cli-core', 'src'), home: 'core' },
  { name: '@kuiralabs/midnight-chain', root: join(ROOT, 'packages', 'chain'), dir: join(ROOT, 'packages', 'chain', 'src'), home: 'chain' },
  { name: '@kuiralabs/midnight-wallet', root: join(ROOT, 'packages', 'wallet'), dir: join(ROOT, 'packages', 'wallet', 'src'), home: 'wallet' },
  { name: '@kuiralabs/midnight-contract', root: join(ROOT, 'packages', 'contract'), dir: join(ROOT, 'packages', 'contract', 'src'), home: 'contract' },
  { name: '@kuiralabs/midnight-connect', root: join(ROOT, 'packages', 'connect'), dir: join(ROOT, 'packages', 'connect', 'src'), home: 'connect' },
  { name: '@kuiralabs/midnight-dev', root: join(ROOT, 'packages', 'dev'), dir: join(ROOT, 'packages', 'dev', 'src'), home: 'dev' },
  { name: '@kuiralabs/midnight-grant', root: join(ROOT, 'packages', 'grant'), dir: join(ROOT, 'packages', 'grant', 'src'), home: 'grant' },
  // The rc engine: its files read as engine/rc/<file>, its index the package itself.
  { name: '@kuiralabs/midnight-engine-rc', root: join(ROOT, 'packages', 'engine-rc'), dir: join(ROOT, 'packages', 'engine-rc', 'src'), prefix: 'engine/rc/', home: 'engine' },
  { name: '@kuiralabs/midnight-engine-beta', root: join(ROOT, 'packages', 'engine-beta'), dir: join(ROOT, 'packages', 'engine-beta', 'src'), prefix: 'engine/beta/', home: 'engine' },
];

/** The package source folder a file is in, or undefined for one under src/. */
const packageOf = (file) => WORKSPACE_PACKAGES.find((pkg) => file.startsWith(pkg.dir + '/'));

/** The workspace package a specifier names (`@kuiralabs/midnight-cli-core` or a subpath of it), or undefined. */
const packageNamed = (specifier) => WORKSPACE_PACKAGES.find((p) => specifier === p.name || specifier.startsWith(p.name + '/'));

/** The subpath of a package a specifier names: `.` for the package itself, `./lib/errors` for `<name>/lib/errors`. */
const subpathOf = (pkg, specifier) => (specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`);

/** A package's exports map, as its package.json has it now. */
const exportsOf = (pkg) => JSON.parse(readFileSync(join(pkg.root, 'package.json'), 'utf8')).exports ?? {};

/** The source module an export names: the workspace's source condition. */
function exportSource(pkg, subpath, target) {
  const source = typeof target === 'string' ? target : target['midnight-cli-source'];
  if (typeof source !== 'string') throw new Error(`${pkg.name}: export ${subpath} names no source module`);
  return source;
}

/** The entry points a workspace package's exports map lists (a pattern such as `./*` among them). */
export function entryPoints(pkg) {
  return Object.keys(exportsOf(pkg));
}

/**
 * The source file a workspace package's subpath (`.`, `./ui`) names through
 * its exports map: an entry of its own, or one a pattern entry (`./*`) matches;
 * undefined when the map has no entry for it, which makes an import of it a
 * deep import.
 */
export function entrySource(pkg, subpath) {
  const map = exportsOf(pkg);
  if (map[subpath] !== undefined) return join(pkg.root, exportSource(pkg, subpath, map[subpath]));
  for (const [key, target] of Object.entries(map)) {
    if (!key.includes('*')) continue;
    const [before, after] = key.split('*');
    if (subpath.length <= before.length + after.length || !subpath.startsWith(before) || !subpath.endsWith(after)) continue;
    const stem = subpath.slice(before.length, subpath.length - after.length);
    return join(pkg.root, exportSource(pkg, key, target).replace('*', stem));
  }
  return undefined;
}

/** Whether a file is one a package's exports map names outright (not through a pattern): an entry point's module. */
function isEntryModule(file) {
  const pkg = packageOf(file);
  if (pkg === undefined) return false;
  return Object.entries(exportsOf(pkg)).some(([key, target]) => !key.includes('*') && join(pkg.root, exportSource(pkg, key, target)) === file);
}

/** A file's path as the homes read it: under its package's source folder, or under src/. */
export function relOf(file) {
  const pkg = packageOf(file);
  return (pkg?.prefix ?? '') + relative(pkg?.dir ?? SRC, file);
}

/** Where a file is, for a report: from the repository's root. */
const shown = (file) => relative(ROOT, file);

/** The source files of src/ and of every workspace package, tests left out; or those under `dir`. */
export function sourceFiles(dir) {
  if (dir === undefined) return [SRC, ...WORKSPACE_PACKAGES.map((pkg) => pkg.dir)].flatMap((d) => sourceFiles(d));
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') files.push(...sourceFiles(path));
    } else if (name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

/** The TypeScript files of every `__tests__` folder of src/ and of the workspace packages, the layering check's own fixtures left out. */
export function testFiles() {
  const walk = (dir, inTests) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return path === LAYERING_FIXTURES ? [] : walk(path, inTests || name === '__tests__');
    return inTests && name.endsWith('.ts') ? [path] : [];
  });
  return [SRC, ...WORKSPACE_PACKAGES.map((pkg) => pkg.dir)].flatMap((dir) => walk(dir, false));
}

/** The repository's scripts (scripts/*.ts and *.mjs), those UNSCANNED_SCRIPTS names left out. */
export function scriptFiles() {
  return readdirSync(SCRIPTS).filter((name) => /\.(ts|mjs)$/.test(name) && UNSCANNED_SCRIPTS[name] === undefined).map((name) => join(SCRIPTS, name));
}

/** The TypeScript files of test-support/. */
export function testSupportFiles() {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : name.endsWith('.ts') ? [path] : [];
  });
  return walk(TEST_SUPPORT);
}

export function homeOf(file) {
  const rel = relOf(file);
  const home = HOMES.find(([, pattern]) => pattern.test(rel))?.[0];
  // A package's entry points (its index, its barrels) are its own.
  return home ?? (isEntryModule(file) ? packageOf(file).home : undefined);
}

const isGuidance = (rel) => /\.guidance\.ts$/.test(rel);

/**
 * Agent guidance is plain text for the shell and the MCP server to assemble:
 * a guidance file imports only core (the guidance type) and its own package,
 * and no other package imports it. Paths are relative to src/.
 * Returns the rule the import breaks, or undefined.
 */
export function guidanceRule(fromRel, toRel) {
  const home = homeOf(join(SRC, fromRel));
  const targetHome = homeOf(join(SRC, toRel));
  if (home === undefined || targetHome === undefined || targetHome === home) return undefined;
  if (isGuidance(fromRel) && targetHome !== 'core') return `${home} guidance → ${targetHome}`;
  if (isGuidance(toRel) && !DISPATCHERS.has(home)) return `${home} → ${targetHome} guidance`;
  return undefined;
}

/**
 * The rule an import from one file of src/ to another breaks, or undefined.
 * Paths are relative to src/; a target with no package is not judged here.
 */
export function importRule(fromRel, toRel) {
  const home = homeOf(join(SRC, fromRel));
  const targetHome = homeOf(join(SRC, toRel));
  if (home === undefined || targetHome === undefined) return undefined;
  const guidance = guidanceRule(fromRel, toRel);
  if (guidance !== undefined) return guidance;
  const isCommand = (path) => path.startsWith('commands/');
  // A package's codes (<package>.codes.ts) are data, not a command: its own code and the packages above it name its sets of codes.
  const isCodes = (path) => /\.codes\.ts$/.test(path);
  const callsCommand = isCommand(toRel) && !isCodes(toRel) && (!isCommand(fromRel) || targetHome !== home);
  if (callsCommand && !DISPATCHERS.has(home)) return `${isCommand(fromRel) ? 'command' : 'library'} → ${targetHome} command`;
  if (targetHome === 'engine' && home !== 'engine') {
    return fromRel === ENGINE_LOADER ? undefined : `${home} → engine (reach it through ${ENGINE_LOADER})`;
  }
  if (!MAY_IMPORT[home].includes(targetHome)) return `${home} → ${targetHome}`;
  if (toRel === SDK_ERRORS && home !== 'engine' && !SDK_ERROR_READERS.test(fromRel)) return `${home} → the SDK's errors (only an engine reads them)`;
  return undefined;
}

/**
 * Whether the import ending at `index` brings in types alone: `import type …`
 * or `export type … from`, or a `typeof import(…)` in a type. Such an import
 * runs nothing, so it adds no code a module can throw (scripts/code-reach.mjs).
 */
function isTypeOnly(source, match) {
  const before = source.slice(0, match.index);
  if (match[0].includes('(')) return /\btypeof\s+$/.test(before);
  if (!/^from\b/.test(match[0])) return false;
  const start = Math.max(before.lastIndexOf('import '), before.lastIndexOf('export '));
  return start >= 0 && /^(import|export)\s+type\s/.test(source.slice(start, match.index));
}

/**
 * The names an import brings in, each with whether it is a type alone, read
 * from the code (`code`, with strings and comments blanked): `import { a, type
 * B } from`, `import x from` (default), `export { a } from`, and for an
 * `import()` the names destructured from it or the one read off it. null when
 * it brings in a whole module: `import * as`, `export * from`, `import 'x'`,
 * or an `import()` used whole.
 */
function importedNames(code, match) {
  const at = match.index;
  if (match[0].includes('(')) {
    const after = code.slice(at + match[0].length);
    const read = /^\s*\)\s*\)?\s*\.\s*(\w+)/.exec(after);
    if (read !== null) return [{ name: read[1], typeOnly: false }];
    const destructured = /\{([^{}]*)\}\s*=\s*await\s*$/.exec(code.slice(0, at));
    if (destructured === null) return null;
    return destructured[1].split(',').map((part) => part.trim()).filter(Boolean).map((part) => ({ name: part.split(':')[0].trim(), typeOnly: false }));
  }
  if (!/^from\b/.test(match[0])) return null;
  const keywords = [...code.slice(0, at).matchAll(/\b(import|export)\b/g)];
  const keyword = keywords[keywords.length - 1];
  if (keyword === undefined) return null;
  const clause = code.slice(keyword.index + keyword[0].length, at).trim();
  const allTypes = /^type\s/.test(clause);
  const rest = allTypes ? clause.slice(4).trim() : clause;
  if (rest.startsWith('*')) return null;
  const names = [];
  const defaultName = /^(\w+)\s*(,|$)/.exec(rest);
  if (defaultName !== null) names.push({ name: 'default', typeOnly: allTypes });
  const braces = /\{([^}]*)\}/.exec(rest);
  for (const part of braces === null ? [] : braces[1].split(',')) {
    const each = /^(type\s+)?(\w+)(\s+as\s+\w+)?$/.exec(part.trim());
    if (each !== null) names.push({ name: each[2], typeOnly: allTypes || each[1] !== undefined });
  }
  return names;
}

/**
 * A file's imports: each specifier, its line, whether it is an `import()`,
 * whether it brings in types alone, and the names it brings in (null for a
 * whole module; importedNames).
 */
export function importsOf(file) {
  const source = readFileSync(file, 'utf8');
  const code = codeOnly(source);
  const found = [];
  for (const match of source.matchAll(IMPORT)) {
    const line = source.slice(0, match.index).split('\n').length;
    found.push({ specifier: match[2], line, dynamic: match[0].includes('('), typeOnly: isTypeOnly(source, match), names: importedNames(code, match) });
  }
  return found;
}

/**
 * The source file an import of `file` names: a relative path, or a workspace
 * package's entry point, through its exports map (`@kuiralabs/midnight-cli-core`
 * is the module its `.` entry names); undefined for an outside package, or for
 * a subpath the exports map lacks (a deep import).
 */
export function importTarget(file, specifier) {
  const pkg = packageNamed(specifier);
  if (pkg !== undefined) return entrySource(pkg, subpathOf(pkg, specifier));
  return specifier.startsWith('.') ? resolve(dirname(file), specifier) : undefined;
}

/** The TypeScript source an import's target is, with its .ts or index.ts filled in; undefined for a file that isn't there. */
export function tsSourceOf(target) {
  for (const candidate of [target, `${target}.ts`, join(target, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && candidate.endsWith('.ts')) return candidate;
  }
  return undefined;
}

// `export { a, type B } from '…'` and `export type { … } from '…'`, in code with string contents blanked.
const RE_EXPORT = /\bexport\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])/g;

/**
 * A barrel's re-exports, exported name → { file, name, typeOnly }: the module
 * defining it and its name there. undefined for a module that is not a barrel
 * (one holding anything besides `export { … } from` lists).
 */
export function barrelExports(file) {
  const source = readFileSync(file, 'utf8');
  const code = codeOnly(source);
  if (!/^\s*(export\s+(type\s+)?\{[^}]*\}\s*from\s*(['"])\s*\3\s*;?\s*)+$/.test(code)) return undefined;
  const names = new Map();
  for (const match of code.matchAll(RE_EXPORT)) {
    const quote = match.index + match[0].length - 1;
    const specifier = source.slice(quote + 1, source.indexOf(source[quote], quote + 1));
    const target = tsSourceOf(resolve(dirname(file), specifier));
    if (target === undefined) throw new Error(`${shown(file)} re-exports from ${specifier}, which is not a source file`);
    for (const part of match[2].split(',').map((each) => each.trim()).filter(Boolean)) {
      const each = /^(type\s+)?(\w+)(?:\s+as\s+(\w+))?$/.exec(part);
      if (each === null) throw new Error(`${shown(file)}: can't read the re-export "${part}"`);
      names.set(each[3] ?? each[2], { file: target, name: each[2], typeOnly: match[1] !== undefined || each[1] !== undefined });
    }
  }
  return names;
}

/**
 * The modules an import of `file` brings in, each with whether it brings in
 * types alone: the module it names or, when that is a barrel, the modules
 * defining the names it imports (every module the barrel re-exports from,
 * for a whole-module import). Returns { modules }, { refused } (the entry
 * points of a workspace package whose exports map lacks the subpath), or
 * undefined for an outside package.
 */
export function importedModules(file, { specifier, typeOnly, names }) {
  const pkg = packageNamed(specifier);
  const target = importTarget(file, specifier);
  if (pkg !== undefined && target === undefined) return { refused: entryPoints(pkg) };
  if (target === undefined) return undefined;
  const modules = new Map();
  const add = (each, typesAlone) => modules.set(each, (modules.get(each) ?? true) && typesAlone);
  const follow = (module, wanted, typesAlone) => {
    const barrel = tsSourceOf(module) === undefined ? undefined : barrelExports(tsSourceOf(module));
    if (barrel === undefined) return add(module, typesAlone);
    const picked = wanted === null ? [...barrel.keys()].map((name) => ({ name, typeOnly: false })) : wanted;
    for (const { name, typeOnly: typeName } of picked) {
      const definer = barrel.get(name);
      if (definer === undefined) add(tsSourceOf(module), typesAlone || typeName);
      else follow(definer.file, [{ name: definer.name, typeOnly: false }], typesAlone || typeName || definer.typeOnly);
    }
  };
  follow(target, names ?? null, typeOnly);
  return { modules: [...modules].map(([each, typesAlone]) => ({ file: each, typeOnly: typesAlone })) };
}

/** Whether a file is core's host-called process code: its process directory, or the "./process" entry point listing it. */
const isProcessCode = (file) => file.startsWith(CORE_PROCESS_DIR + '/') || file === `${CORE_PROCESS_DIR}.ts`;

/** The rule an import from `file` (whose package is `home`) of `modules` breaks by reaching core's process code, or undefined. */
export function processCodeRule(file, home, modules) {
  if (home === 'shell' || isProcessCode(file)) return undefined;
  return modules.some((module) => isProcessCode(module.file)) ? `${home} → core's process code (only a host calls it, through "./process")` : undefined;
}

/** The refusal of a deep import into `pkg`, naming its entry points. */
const deepImportRule = (pkg, entries) => `deep import into ${pkg} (its entry points: ${entries.join(', ')})`;

/** The imports of a source file that break a rule. */
function sourceProblems(file) {
  const rel = relOf(file);
  const home = homeOf(file);
  const from = packageOf(file);
  const violations = [];
  for (const imported of importsOf(file)) {
    const { specifier, line } = imported;
    const where = `${shown(file)}:${line}`;
    const pkg = packageNamed(specifier);
    if (specifier.startsWith('.') && from !== undefined && packageOf(resolve(dirname(file), specifier)) !== from) {
      violations.push({ home, rule: `${home} package → outside it (a package imports another only by name)`, where, specifier });
      continue;
    }
    const resolved = specifier.startsWith('.') || pkg !== undefined ? importedModules(file, imported) : undefined;
    if (resolved?.refused !== undefined) {
      violations.push({ home, rule: deepImportRule(pkg.name, resolved.refused), where, specifier });
      continue;
    }
    if (resolved !== undefined) {
      // No package reaches core's process code, not even through a barrel of its own.
      const processRule = processCodeRule(file, home, resolved.modules);
      if (processRule !== undefined) {
        violations.push({ home, rule: processRule, where, specifier });
        continue;
      }
      // A barrel only lists its own package's modules for the packages above; it calls nothing.
      if (barrelExports(file) !== undefined) continue;
      const rules = new Set(resolved.modules.map((module) => importRule(rel, relOf(module.file))).filter((rule) => rule !== undefined));
      for (const rule of rules) violations.push({ home, rule, where, specifier });
    } else if (MIDNIGHT_SDK.test(specifier) && home !== 'engine') {
      violations.push({ home, rule: `${home} → Midnight SDK (only an engine imports it)`, where, specifier });
    } else if (accountImportRule(home, specifier, imported.typeOnly) !== undefined) {
      violations.push({ home, rule: accountImportRule(home, specifier, imported.typeOnly), where, specifier });
    }
  }
  return violations;
}

/** The folder of the package a file is in: a workspace package's, or the repository's root for mn's own (src/, scripts/). */
const packageRootOf = (file) => WORKSPACE_PACKAGES.find((pkg) => file.startsWith(pkg.root + '/'))?.root ?? ROOT;

/**
 * The imports of a test file that break a rule: a test imports its own
 * package relatively and every other workspace package by an entry point.
 */
export function testProblems(file) {
  const own = packageRootOf(file);
  const violations = [];
  for (const { specifier, line } of importsOf(file)) {
    const where = `${shown(file)}:${line}`;
    const pkg = packageNamed(specifier);
    const target = specifier.startsWith('.') ? resolve(dirname(file), specifier) : undefined;
    if (target !== undefined && !target.startsWith(TEST_SUPPORT + '/') && packageRootOf(target) !== own) {
      violations.push({ home: 'test', rule: 'test → another package by path (a test imports another package by its entry points)', where, specifier });
    } else if (pkg !== undefined && pkg.root === own) {
      violations.push({ home: 'test', rule: 'test → its own package by name (a test imports its own package relatively)', where, specifier });
    } else if (pkg !== undefined && importTarget(file, specifier) === undefined) {
      violations.push({ home: 'test', rule: deepImportRule(pkg.name, entryPoints(pkg)), where, specifier });
    }
  }
  return violations;
}

/**
 * The imports of a test-support file that break a rule: it imports a
 * workspace package by an entry point, and of mn's own code only the shell's
 * list of engines (TEST_SUPPORT_MAY_IMPORT).
 */
export function testSupportProblems(file) {
  const violations = [];
  for (const { specifier, line } of importsOf(file)) {
    const where = `${shown(file)}:${line}`;
    const pkg = packageNamed(specifier);
    const target = specifier.startsWith('.') ? resolve(dirname(file), specifier) : undefined;
    if (target !== undefined && !target.startsWith(TEST_SUPPORT + '/') && !TEST_SUPPORT_MAY_IMPORT.includes(target)) {
      violations.push({ home: 'test-support', rule: "test-support → code by path (it imports a package by its entry points, and of mn's code only lib/installed-engines.ts)", where, specifier });
    } else if (pkg !== undefined && importTarget(file, specifier) === undefined) {
      violations.push({ home: 'test-support', rule: deepImportRule(pkg.name, entryPoints(pkg)), where, specifier });
    }
  }
  return violations;
}

/** The imports of a script that break a rule: a script imports a workspace package by an entry point. */
function scriptProblems(file) {
  const violations = [];
  for (const { specifier, line } of importsOf(file)) {
    const where = `${shown(file)}:${line}`;
    const pkg = packageNamed(specifier);
    if (specifier.startsWith('.') && packageRootOf(resolve(dirname(file), specifier)) !== ROOT) {
      violations.push({ home: 'script', rule: 'script → a package by path (a script imports a package by its entry points)', where, specifier });
    } else if (pkg !== undefined && importTarget(file, specifier) === undefined) {
      violations.push({ home: 'script', rule: deepImportRule(pkg.name, entryPoints(pkg)), where, specifier });
    }
  }
  return violations;
}

/** Files with no package, and imports that break a rule: in the source, the tests and the scripts. */
export function findLayeringProblems() {
  const unhomed = [];
  const violations = [];
  for (const file of sourceFiles()) {
    if (homeOf(file) === undefined) unhomed.push(shown(file));
    else violations.push(...sourceProblems(file));
  }
  for (const file of testFiles()) violations.push(...testProblems(file));
  for (const file of testSupportFiles()) violations.push(...testSupportProblems(file));
  for (const file of scriptFiles()) violations.push(...scriptProblems(file));
  return { unhomed, violations };
}

function report({ unhomed, violations }) {
  for (const file of unhomed) process.stdout.write(`no package: ${file}\n`);

  const byRule = (list) => {
    const groups = new Map();
    for (const v of list) groups.set(v.rule, [...(groups.get(v.rule) ?? []), v]);
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  };
  for (const [rule, list] of byRule(violations)) {
    process.stdout.write(`\n${rule} (${list.length})\n`);
    for (const v of list) process.stdout.write(`  ${v.where}  ${v.specifier}\n`);
  }

  const problems = unhomed.length + violations.length;
  process.stdout.write(`\n${problems === 0 ? 'Layering holds.' : `${violations.length} import(s) break the layering; ${unhomed.length} file(s) have no package.`}\n`);
  return problems === 0;
}

// Run as a script; imported, it lends its package table and its rules.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const ok = report(findLayeringProblems());
  process.exit(ok ? 0 : 1);
}
