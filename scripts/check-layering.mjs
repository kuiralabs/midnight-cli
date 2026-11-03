#!/usr/bin/env node
// Checks that src/ respects the package layering of the planned split: which
// future package each file belongs to, which packages it may import, and which
// external packages it may not. Every import counts, dynamic and type-only ones
// included, because each becomes a package dependency once the code is split.
//
// Libraries never call commands, and commands never call another package's
// commands: a command is an adapter over library functions, and only the shell
// and the MCP server dispatch to one.
//
// Usage: node scripts/check-layering.mjs
// Imported, it exports sourceFiles and homeOf: which package each file of src/ is in;
// importRule and guidanceRule: the rule an import breaks; and findLayeringProblems,
// which the suite runs. Exits 1 when a file has no package, or an import breaks a rule.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// The packages of the split, in the layering's order.
const PACKAGES = ['core', 'chain', 'wallet', 'contract', 'connect', 'swap', 'dev', 'grant'];

// Which package a file belongs to: the first pattern that matches its path
// under src/ wins. A file that matches nothing fails the check.
const HOMES = [
  ['shell', /^wallet\.ts$/],
  // help plays the shell's intro, and manual builds the full manual; both render the installed registry.
  ['shell', /^commands\/(help|manual)(\.definition)?\.ts$/],
  ['shell', /^lib\/(heap-guard|node-version|intro-marker|output-redaction|run-command|sdk-noise|cli-host|installed-commands|installed-engines|command-dispatch|agent-manual|readme-commands)\.ts$/],
  ['shell', /^ui\/(animate|art)\.ts$/],
  ['mcp', /^mcp-server\.ts$/],
  ['mcp', /^lib\/mcp\//],

  // A package's agent guidance (<package>.guidance.ts) sits beside its commands.
  ...PACKAGES.map((pkg) => [pkg, new RegExp(`^commands/${pkg}\\.guidance\\.ts$`)]),

  // A command's definition (<name>.definition.ts) lives in its command's package.
  ['core', /^commands\/config(\.definition)?\.ts$/],
  // The SDK engines: each is the only code that imports its SDK set.
  ['engine', /^engine\//],

  ['core', /^lib\/(argv|errors|engine|exit-codes|json-output|constants|cli-config|network|network-id|resolve-network|payer|blockfrost|durable-file|keystore|pkg|verbose|error-trim|command-flags|phase-tracker|sdk-errors|amount|duration|sdk-warnings|notices|prompter|settings|state-root|command-definition|call-context|sleep|exec-program|agent-guidance|wallet-cache|cache-indexer|reader-cache-files|connector-api|dust-wait|fee-limits|tx-serde|sign-data|approval|dust-balancing-plan|dust-registration-plan|shielded-policy|wallet-session|sdk-layout|swap-offer|offer-envelope|open-offers)\.ts$/],
  ['core', /^ui\/(colors|format|spinner|terminal-prompter)\.ts$/],
  ['dev', /^ui\/(test-create-prompt|dev-keys)\.ts$/],

  ['chain', /^commands\/(status|tx)(\.definition)?\.ts$/],
  ['chain', /^lib\/(node-rpc|chain-id|indexer-graphql|graphql-ws-subscription|event-tip|ledger-guard|node-ready|indexer-ready|proof-server-ready|chain-clock|endpoint-check|balance-subscription|tx-segments|tx-status|tx-receipt|offer-liveness)\.ts$/],

  ['wallet', /^commands\/(wallet|generate|address|genesis-address|info|balance|transfer|airdrop|dust|cache)(\.definition)?\.ts$/],
  ['wallet', /^lib\/(derivation|derive-address|wallet-config|seed-resolver|passphrase|facade|wallet-data-repository|transfer|transfer-request|sync-eta|wallet-can-pay|wallet-create|airdrop|wallet-protector|chain-caches|wallet-paths|fork-schedule)\.ts$/],
  ['wallet', /^lib\/(dust-[a-z-]+|shielded-[a-z-]+)\.ts$/],
  ['wallet', /^ui\/receipt\.ts$/],

  ['contract', /^commands\/(contract|inspect-cost)(\.definition)?\.ts$/],
  ['contract', /^lib\/contract\//],
  ['contract', /^lib\/chain-params\.ts$/],

  ['connect', /^commands\/serve(\.definition)?\.ts$/],
  ['connect', /^lib\/(dapp-connector|ws-rpc|sign-recipe|serve-manager|serve-payer)\.ts$/],

  ['swap', /^commands\/swap(\.definition)?\.ts$/],
  ['swap', /^lib\/swap\//],

  ['dev', /^commands\/(dev|test|localnet)(\.definition)?\.ts$/],
  ['dev', /^lib\/localnet\.ts$/],
  ['dev', /^lib\/(dev|test)\//],

  ['grant', /^commands\/grant(\.definition)?\.ts$/],
  ['grant', /^lib\/grant\//],
];

// The packages each package may import, its own included. Dependencies point
// one way: core, chain, wallet, then contract and connect side by side, then
// swap (on connect's wallet session), then dev, then grant. An engine sits beside chain: it uses core and chain, and
// nothing imports it but core's loader.
const MAY_IMPORT = {
  engine: ['core', 'chain', 'engine'],
  core: ['core'],
  chain: ['core', 'chain'],
  wallet: ['core', 'chain', 'wallet'],
  contract: ['core', 'chain', 'wallet', 'contract'],
  connect: ['core', 'chain', 'wallet', 'connect'],
  swap: ['core', 'chain', 'wallet', 'connect', 'swap'],
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

const ACCOUNT_CHAIN = /^@kuiralabs\/midnight-account/;

// import ... from 'x', export ... from 'x', import 'x', import('x').
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm;

// The workspace packages carved out of src/, each with its source folder and
// the home it is. A file's path in a package (lib/argv.ts) reads as it did
// under src/, so the homes and rules above apply to it unchanged.
export const WORKSPACE_PACKAGES = [
  { name: '@kuiralabs/midnight-cli-core', dir: join(ROOT, 'packages', 'cli-core', 'src') },
  { name: '@kuiralabs/midnight-chain', dir: join(ROOT, 'packages', 'chain', 'src') },
  // The rc engine: its files read as engine/rc/<file>, its index the package itself.
  { name: '@kuiralabs/midnight-engine-rc', dir: join(ROOT, 'packages', 'engine-rc', 'src'), prefix: 'engine/rc/' },
  { name: '@kuiralabs/midnight-engine-beta', dir: join(ROOT, 'packages', 'engine-beta', 'src'), prefix: 'engine/beta/' },
];

/** The package source folder a file is in, or undefined for one under src/. */
const packageOf = (file) => WORKSPACE_PACKAGES.find((pkg) => file.startsWith(pkg.dir + '/'));

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

export function homeOf(file) {
  const rel = relOf(file);
  return HOMES.find(([, pattern]) => pattern.test(rel))?.[0];
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
  const callsCommand = isCommand(toRel) && (!isCommand(fromRel) || targetHome !== home);
  if (callsCommand && !DISPATCHERS.has(home)) return `${isCommand(fromRel) ? 'command' : 'library'} → ${targetHome} command`;
  if (targetHome === 'engine' && home !== 'engine') {
    return fromRel === ENGINE_LOADER ? undefined : `${home} → engine (reach it through ${ENGINE_LOADER})`;
  }
  if (!MAY_IMPORT[home].includes(targetHome)) return `${home} → ${targetHome}`;
  return undefined;
}

function importsOf(file) {
  const source = readFileSync(file, 'utf8');
  const found = [];
  for (const match of source.matchAll(IMPORT)) {
    const line = source.slice(0, match.index).split('\n').length;
    found.push({ specifier: match[2], line });
  }
  return found;
}

/** Files with no package, and imports that break a rule. */
export function findLayeringProblems() {
  const unhomed = [];
  const violations = [];
  for (const file of sourceFiles()) {
    const rel = relOf(file);
    const home = homeOf(file);
    if (home === undefined) {
      unhomed.push(shown(file));
      continue;
    }
    for (const { specifier, line } of importsOf(file)) {
      const where = `${shown(file)}:${line}`;
      const pkg = WORKSPACE_PACKAGES.find((p) => specifier === p.name || specifier.startsWith(p.name + '/'));
      const from = packageOf(file);
      if (specifier.startsWith('.') && from !== undefined && packageOf(resolve(dirname(file), specifier)) !== from) {
        violations.push({ home, rule: `${home} package → outside it (a package imports another only by name)`, where, specifier });
        continue;
      }
      if (specifier.startsWith('.') || pkg !== undefined) {
        const target = pkg !== undefined ? `${pkg.prefix ?? ''}${specifier === pkg.name ? 'index' : specifier.slice(pkg.name.length + 1)}.ts` : relOf(resolve(dirname(file), specifier));
        const rule = importRule(rel, target);
        if (rule !== undefined) violations.push({ home, rule, where, specifier });
      } else if (MIDNIGHT_SDK.test(specifier) && home !== 'engine') {
        violations.push({ home, rule: `${home} → Midnight SDK (only an engine imports it)`, where, specifier });
      } else if (home !== 'grant' && ACCOUNT_CHAIN.test(specifier)) {
        violations.push({ home, rule: `${home} → account chain`, where, specifier });
      }
    }
  }
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
