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
const PACKAGES = ['core', 'chain', 'wallet', 'contract', 'connect', 'dev', 'grant'];

// Which package a file belongs to: the first pattern that matches its path
// under src/ wins. A file that matches nothing fails the check.
const HOMES = [
  ['shell', /^wallet\.ts$/],
  // help plays the shell's intro, and manual builds the full manual; both render the installed registry.
  ['shell', /^commands\/(help|manual)(\.definition)?\.ts$/],
  ['shell', /^lib\/(heap-guard|node-version|intro-marker|output-redaction|run-command|sdk-noise|cli-host|installed-commands|command-dispatch|agent-manual|readme-commands)\.ts$/],
  ['shell', /^ui\/(animate|art)\.ts$/],
  ['mcp', /^mcp-server\.ts$/],
  ['mcp', /^lib\/mcp\//],

  // A package's agent guidance (<package>.guidance.ts) sits beside its commands.
  ...PACKAGES.map((pkg) => [pkg, new RegExp(`^commands/${pkg}\\.guidance\\.ts$`)]),

  // A command's definition (<name>.definition.ts) lives in its command's package.
  ['core', /^commands\/config(\.definition)?\.ts$/],
  // The SDK engines: each is the only code that imports its SDK set.
  ['engine', /^engine\//],

  ['core', /^lib\/(argv|errors|engine|exit-codes|json-output|constants|cli-config|network|network-id|resolve-network|payer|blockfrost|durable-file|keystore|pkg|verbose|error-trim|command-flags|phase-tracker|sdk-errors|amount|duration|sdk-warnings|notices|prompter|settings|state-root|command-definition|call-context|sleep|exec-program|agent-guidance)\.ts$/],
  ['core', /^ui\/(colors|format|spinner|terminal-prompter)\.ts$/],
  ['dev', /^ui\/(test-create-prompt|dev-keys)\.ts$/],

  ['chain', /^commands\/status(\.definition)?\.ts$/],
  ['chain', /^lib\/(node-rpc|chain-id|indexer-graphql|graphql-ws-subscription|event-tip|ledger-guard|node-ready|indexer-ready|proof-server-ready|chain-clock|endpoint-check|balance-subscription)\.ts$/],

  ['wallet', /^commands\/(wallet|generate|address|genesis-address|info|balance|transfer|airdrop|dust|cache)(\.definition)?\.ts$/],
  ['wallet', /^lib\/(derivation|derive-address|wallet-config|seed-resolver|passphrase|facade|wallet-data-repository|wallet-cache|cache-indexer|transfer|transfer-request|sync-eta|wallet-can-pay|wallet-create|airdrop|wallet-protector|chain-caches|wallet-paths|fork-schedule)\.ts$/],
  ['wallet', /^lib\/(dust-[a-z-]+|shielded-[a-z-]+)\.ts$/],

  ['contract', /^commands\/(contract|inspect-cost)(\.definition)?\.ts$/],
  ['contract', /^lib\/contract\//],
  ['contract', /^lib\/chain-params\.ts$/],

  ['connect', /^commands\/serve(\.definition)?\.ts$/],
  ['connect', /^lib\/(dapp-connector|ws-rpc|approval|fee-limits|fee-only-check|sign-data|sign-recipe|tx-inspect|tx-segments|tx-serde|serve-manager|serve-payer)\.ts$/],

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

// The one module that may import an engine: core's loader, which imports the
// engine for a network's SDK set when a call needs it.
const ENGINE_LOADER = 'lib/engine.ts';

// Modules that still import the SDK themselves, until each moves behind the
// engine; a module on the list may also import the engine's own files. The
// list only shrinks (a test pins it), and is empty when the engine is done.
export const PENDING_ENGINE = new Set([
  'commands/airdrop.ts',
  'commands/balance.ts',
  'commands/dust.ts',
  'commands/transfer.ts',
  'lib/contract/providers.ts',
  'lib/contract/runner.ts',
  'lib/dapp-connector.ts',
  'lib/dust-balance-direct.ts',
  'lib/dust-collapse.ts',
  'lib/dust-direct-cache.ts',
  'lib/dust-direct.ts',
  'lib/dust-sync-native.ts',
  'lib/dust-wallet.ts',
  'lib/facade.ts',
  'lib/fork-schedule.ts',
  'lib/grant/sealed-account.ts',
  'lib/shielded-direct-cache.ts',
  'lib/shielded-direct.ts',
  'lib/sign-recipe.ts',
  'lib/test/prep-runner.ts',
  'lib/transfer-request.ts',
  'lib/transfer.ts',
  'lib/wallet-data-repository.ts',
  'lib/ws-rpc.ts',
]);
const ACCOUNT_CHAIN = /^@kuiralabs\/midnight-account/;
const SDK_FREE = new Set(['core', 'chain']);

// import ... from 'x', export ... from 'x', import 'x', import('x').
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm;

export function sourceFiles(dir = SRC) {
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
  const rel = relative(SRC, file);
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
    return fromRel === ENGINE_LOADER || PENDING_ENGINE.has(fromRel) ? undefined : `${home} → engine (reach it through ${ENGINE_LOADER})`;
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
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    const home = homeOf(file);
    if (home === undefined) {
      unhomed.push(rel);
      continue;
    }
    for (const { specifier, line } of importsOf(file)) {
      const where = `src/${rel}:${line}`;
      if (specifier.startsWith('.')) {
        const rule = importRule(rel, relative(SRC, resolve(dirname(file), specifier)));
        if (rule !== undefined) violations.push({ home, rule, where, specifier });
      } else if (MIDNIGHT_SDK.test(specifier) && home !== 'engine' && (SDK_FREE.has(home) || !PENDING_ENGINE.has(rel))) {
        violations.push({ home, rule: `${home} → Midnight SDK (only an engine imports it)`, where, specifier });
      } else if (home !== 'grant' && ACCOUNT_CHAIN.test(specifier)) {
        violations.push({ home, rule: `${home} → account chain`, where, specifier });
      }
    }
  }
  return { unhomed, violations };
}

function report({ unhomed, violations }) {
  for (const rel of unhomed) process.stdout.write(`no package: src/${rel}\n`);

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
