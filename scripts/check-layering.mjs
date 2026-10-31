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
// Usage: node scripts/check-layering.mjs [--all]
// Imported, it exports sourceFiles and homeOf: which package each file of src/ is in.
// Exits 1 when a file has no package, or an import breaks a rule. The shell and
// the MCP server are reported but do not fail the check until the command
// registry rewires them; --all makes them fail too.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// Which package a file belongs to: the first pattern that matches its path
// under src/ wins. A file that matches nothing fails the check.
const HOMES = [
  ['shell', /^wallet\.ts$/],
  ['shell', /^lib\/(heap-guard|node-version|intro-marker|output-redaction|run-command)\.ts$/],
  ['shell', /^ui\/(animate|art)\.ts$/],
  ['mcp', /^mcp-server\.ts$/],
  ['mcp', /^lib\/mcp\//],

  ['core', /^commands\/(config|help|manual)\.ts$/],
  ['core', /^lib\/(argv|errors|exit-codes|json-output|constants|cli-config|network|network-id|resolve-network|payer|blockfrost|durable-file|keystore|pkg|verbose|error-trim|command-flags|phase-tracker|sdk-errors|amount|duration)\.ts$/],
  ['core', /^ui\/(colors|format|spinner)\.ts$/],

  ['chain', /^commands\/status\.ts$/],
  ['chain', /^lib\/(node-rpc|chain-id|indexer-graphql|graphql-ws-subscription|event-tip|ledger-guard|node-ready|indexer-ready|proof-server-ready|chain-clock|endpoint-check|balance-subscription)\.ts$/],

  ['wallet', /^commands\/(wallet|generate|address|genesis-address|info|balance|transfer|airdrop|dust|cache)\.ts$/],
  ['wallet', /^lib\/(derivation|derive-address|wallet-config|seed-resolver|passphrase|facade|wallet-data-repository|wallet-cache|cache-indexer|transfer|transfer-request|sync-eta|wallet-can-pay|wallet-create|airdrop|wallet-protector|chain-caches|wallet-paths|fork-schedule)\.ts$/],
  ['wallet', /^lib\/(dust-[a-z-]+|shielded-[a-z-]+)\.ts$/],

  ['contract', /^commands\/(contract|inspect-cost)\.ts$/],
  ['contract', /^lib\/contract\//],
  ['contract', /^lib\/chain-params\.ts$/],

  ['connect', /^commands\/serve\.ts$/],
  ['connect', /^lib\/(dapp-connector|ws-rpc|approval|fee-limits|fee-only-check|sign-data|sign-recipe|tx-inspect|tx-segments|tx-serde|serve-manager|serve-payer)\.ts$/],

  ['dev', /^commands\/(dev|test|localnet)\.ts$/],
  ['dev', /^lib\/localnet\.ts$/],
  ['dev', /^lib\/(dev|test)\//],

  ['grant', /^commands\/grant\.ts$/],
  ['grant', /^lib\/grant\//],
];

// The packages each package may import, its own included. Dependencies point
// one way: core, chain, wallet, then contract and connect side by side, then
// dev, then grant.
const MAY_IMPORT = {
  core: ['core'],
  chain: ['core', 'chain'],
  wallet: ['core', 'chain', 'wallet'],
  contract: ['core', 'chain', 'wallet', 'contract'],
  connect: ['core', 'chain', 'wallet', 'connect'],
  dev: ['core', 'chain', 'wallet', 'contract', 'connect', 'dev'],
  grant: ['core', 'chain', 'wallet', 'contract', 'connect', 'dev', 'grant'],
};

// Rewired by the command registry, so reported but not failed until then.
const DEFERRED = new Set(['shell', 'mcp']);

const MIDNIGHT_SDK = /^@midnight(-ntwrk|ntwrk)\//;
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

function importsOf(file) {
  const source = readFileSync(file, 'utf8');
  const found = [];
  for (const match of source.matchAll(IMPORT)) {
    const line = source.slice(0, match.index).split('\n').length;
    found.push({ specifier: match[2], line });
  }
  return found;
}

function check() {
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
        const target = resolve(dirname(file), specifier);
        const targetHome = homeOf(target);
        if (targetHome === undefined) continue;
        const isCommand = (path) => path.startsWith('commands/');
        const callsCommand = isCommand(relative(SRC, target)) && (!isCommand(rel) || targetHome !== home);
        if (callsCommand && !DEFERRED.has(home)) {
          violations.push({ home, rule: `${isCommand(rel) ? 'command' : 'library'} → ${targetHome} command`, where, specifier });
          continue;
        }
        if (targetHome === home) continue;
        if (DEFERRED.has(home)) {
          violations.push({ home, rule: `${home} → ${targetHome}`, where, specifier });
        } else if (!MAY_IMPORT[home].includes(targetHome)) {
          violations.push({ home, rule: `${home} → ${targetHome}`, where, specifier });
        }
      } else if (SDK_FREE.has(home) && MIDNIGHT_SDK.test(specifier)) {
        violations.push({ home, rule: `${home} → Midnight SDK`, where, specifier });
      } else if (home !== 'grant' && ACCOUNT_CHAIN.test(specifier)) {
        violations.push({ home, rule: `${home} → account chain`, where, specifier });
      }
    }
  }
  return { unhomed, violations };
}

function report({ unhomed, violations }, failDeferred) {
  const failing = violations.filter((v) => failDeferred || !DEFERRED.has(v.home));
  const deferred = violations.filter((v) => !failDeferred && DEFERRED.has(v.home));

  for (const rel of unhomed) process.stdout.write(`no package: src/${rel}\n`);

  const byRule = (list) => {
    const groups = new Map();
    for (const v of list) groups.set(v.rule, [...(groups.get(v.rule) ?? []), v]);
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  };
  for (const [rule, list] of byRule(failing)) {
    process.stdout.write(`\n${rule} (${list.length})\n`);
    for (const v of list) process.stdout.write(`  ${v.where}  ${v.specifier}\n`);
  }
  if (deferred.length > 0) {
    process.stdout.write(`\nDeferred to the command registry, not failing: ${deferred.length} imports from the shell and the MCP server\n`);
    for (const [rule, list] of byRule(deferred)) process.stdout.write(`  ${rule}: ${list.length}\n`);
  }

  const problems = unhomed.length + failing.length;
  process.stdout.write(`\n${problems === 0 ? 'Layering holds.' : `${failing.length} import(s) break the layering; ${unhomed.length} file(s) have no package.`}\n`);
  return problems === 0;
}

// Run as a script; imported (by the SDK-free base test), it only lends its package table.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const ok = report(check(), process.argv.includes('--all'));
  process.exit(ok ? 0 : 1);
}
