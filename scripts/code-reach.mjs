#!/usr/bin/env node
// Which error codes each command can end with, read from the code. From a
// command's handler module (its definition's load() target), every module it
// imports, statically or dynamically (type-only imports run nothing and are
// left out), and in each module every coded error it constructs: `new X(` of a
// class whose `readonly code` is a literal, its own or inherited, or an
// EngineError given a literal code. Errors whose code is not a literal in the
// code are read from two tables, each entry with its reason (DYNAMIC_CLASSES,
// DYNAMIC_MODULES); a module constructing a class whose code is not a literal
// and that the first table lacks fails the scan.
//
// An import of a barrel (an entry point made only of `export { … } from`
// lists) reaches the modules defining the names it imports, not every module
// the barrel lists: the others load, but nothing of theirs runs.
//
// Reaches that don't show as imports are added:
//   - the engine: a module that asks the host for one (`engines.load(`,
//     `.for(`, `.any(`) reaches the host's engines and loads every shipped
//     engine's index; one that uses a part of an engine (its keys, ledger,
//     contracts, readers or wallet) reaches that part's modules (ENGINE_SITES);
//   - the shell's payer and protectors, given to a command whose definition
//     asks for them (SHELL_PROVISIONS).
// And one import is not followed: a definition's dynamic ones (its load() and
// its tools' checks), which run only when the shell or the MCP server calls
// them, not when help reads the registry.
//
// Module granularity: a module that can throw a code anywhere counts for every
// command that reaches it.
//
// Usage: node scripts/code-reach.mjs
// Prints each command's reachable codes. Imported, it exports codeReach (the
// codes some entry modules reach), commandEntries (each definition's entry
// modules), the tables, and declaredCodeProblems, which the suite runs
// (src/__tests__/declared-codes.test.ts).

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importTarget, importedModules, importsOf, sourceFiles, tsSourceOf } from './check-layering.mjs';
import { codeOnly } from './check-process-safety.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromRoot = (path) => join(ROOT, path);
const shown = (file) => relative(ROOT, file);

/** Thrown when the code holds a coded error the scan can't read. */
export class CodeReachError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodeReachError';
  }
}

// What the engine contract's typed errors report: toEngineError's and
// withEngineCode's codes, read from an SDK or node failure's shape and words.
const ENGINE_FAILURE_CODES = ['NETWORK_ERROR', 'SYNC_TIMEOUT', 'STALE_CACHE', 'INSUFFICIENT_BALANCE', 'DUST_REQUIRED', 'TX_REJECTED', 'STALE_UTXO', 'INVALID_DUST_PROOF', 'PROOF_TIMEOUT', 'PROOF_FAILURE'];

/**
 * Classes whose code is not a literal in the code, and the codes their
 * construction can carry, with why. EngineError given a literal code counts
 * that code instead.
 */
export const DYNAMIC_CLASSES = {
  EngineError: {
    codes: ENGINE_FAILURE_CODES,
    why: "sdk-errors' typedEngineError makes one for an engine code no subclass names (a refusal's TX_REJECTED), or for a code a DApp connector marked an error with",
  },
  TransactionRefusedError: {
    codes: ['TX_REJECTED', 'STALE_UTXO', 'INVALID_DUST_PROOF'],
    why: "its code is a RefusalCode: the node's reason makes it a stale coin, an invalid Dust proof or another refusal",
  },
  ContractScriptError: {
    codes: ENGINE_FAILURE_CODES,
    why: "a contract script reports the code its failure carried: mn serve's code for a failure there (the engine's, marked by withEngineCode), or NETWORK_ERROR for a connection the script could not make",
  },
  PrepStepFailedError: {
    codes: [],
    why: "it carries its failed step's own error's code, which the step's modules already count",
  },
};

/** Modules that give errors a code read from their shape or words, not by constructing a coded class, with why. */
export const DYNAMIC_MODULES = {
  'packages/cli-core/src/lib/sdk-errors.ts': {
    codes: ENGINE_FAILURE_CODES,
    why: "toEngineError and withEngineCode name an SDK or node failure by the engine contract's codes",
  },
  'packages/cli-core/src/lib/transport-failure.ts': {
    codes: ['NETWORK_ERROR'],
    why: 'withTransportCode reports a connection that could not be made as a NetworkError',
  },
};

/** The engines this build ships, each a workspace package with the same modules. */
const ENGINE_SETS = ['rc', 'beta'];

/**
 * The parts of an Engine and the modules of an engine's package each is made
 * of (its index assembles them); a test holds this to both engines' indexes.
 */
export const ENGINE_PARTS = {
  keys: ['derive-address.ts', 'addresses.ts', 'dust-direct-cache.ts', 'shielded-direct-cache.ts'],
  ledger: ['ledger-parameters.ts', 'tx-inspect.ts', 'offer-reader.ts'],
  contracts: ['contract-providers.ts', 'contract-scripts.ts'],
  readers: ['shielded-direct-cache.ts'],
  wallet: ['wallet.ts', 'wallet-data-repository.ts'],
};

const engineModules = (files) => ENGINE_SETS.flatMap((set) => files.map((file) => `packages/engine-${set}/src/${file}`));

/**
 * Calls that reach an engine, and the modules they reach. Asking the host for
 * one (`engines.load(`, `.for(`, `.any(`) reaches the host's engines and
 * loads every engine's index; using a part of one (`engine.keys.…`, `{ keys }
 * = engine`; for the wallet, calling an operation or taking the wallet from a
 * loaded engine) reaches that part's modules.
 */
export const ENGINE_SITES = [
  {
    site: /\bengines\s*\.\s*(load|for|any)\s*\(/,
    reaches: ['packages/cli-core/src/lib/host.ts', ...engineModules(['index.ts'])],
  },
  ...['keys', 'ledger', 'contracts', 'readers'].map((part) => ({
    site: new RegExp(`\\.\\s*${part}\\b(?!\\s*\\()|\\{[^{}=]*\\b${part}\\b[^{}=]*\\}\\s*=\\s*(await\\b|engine\\b)`),
    reaches: engineModules(ENGINE_PARTS[part]),
  })),
  {
    site: /\.\s*wallet\s*\.\s*\w+\s*\(|\{\s*wallet\s*:\s*\w+\s*\}\s*=\s*await\b/,
    reaches: engineModules(ENGINE_PARTS.wallet),
  },
];

/** Imports the walk doesn't follow: an engine's index imports its parts' modules, which only a use of that part reaches (ENGINE_SITES). */
export const CUT_IMPORTS = ENGINE_SETS.flatMap((set) => [...new Set(Object.values(ENGINE_PARTS).flat())].map((file) => [`packages/engine-${set}/src/index.ts`, `packages/engine-${set}/src/${file}`]));

/** What the shell gives a command whose definition's `shell` asks for it, and the module it loads. */
export const SHELL_PROVISIONS = {
  payer: 'packages/connect/src/lib/serve-payer.ts',
  protectors: 'src/lib/grant/account-protector.ts',
};

// The class EngineError takes its code as its first argument: `new EngineError('X', …)`, or a subclass's `super('X', …)`.
const CODE_FROM_FIRST_ARGUMENT = 'EngineError';

/** The literal string starting at `quote` in `source`. */
function literalAt(source, quote) {
  return source.slice(quote + 1, source.indexOf(source[quote], quote + 1));
}

/** The offset of the brace that closes the one at `open`, in code with strings and comments blanked. */
function closingBrace(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return code.length;
}

/** The classes a file declares: name, parent, and its own code (a literal, `dynamic`, or one passed to super). */
function classesIn(file) {
  const source = readFileSync(file, 'utf8');
  const code = codeOnly(source);
  const found = [];
  for (const match of code.matchAll(/\bclass\s+(\w+)(?:\s+extends\s+(\w+))?[^{]*\{/g)) {
    const open = match.index + match[0].length - 1;
    const body = code.slice(open, closingBrace(code, open));
    const own = /\breadonly\s+code\b\s*(:[^=;\n]*)?(=\s*)?/.exec(body);
    let ownCode;
    if (own !== null) ownCode = own[2] === undefined ? 'dynamic' : literalAt(source, open + own.index + own[0].length);
    const superCall = /\bsuper\(\s*['"]/.exec(body);
    found.push({ name: match[1], parent: match[2], file, ownCode, superCode: superCall === null ? undefined : literalAt(source, open + superCall.index + superCall[0].length - 1) });
  }
  return found;
}

/** Every class of the source files, by name: a name declared twice must mean the same code. */
function classTable(files) {
  const byName = new Map();
  for (const file of files) for (const cls of classesIn(file)) byName.set(cls.name, [...(byName.get(cls.name) ?? []), cls]);
  const resolved = new Map();
  const codeOf = (name, seen = new Set()) => {
    if (resolved.has(name)) return resolved.get(name);
    const all = byName.get(name);
    if (all === undefined || seen.has(name)) return undefined;
    seen.add(name);
    const each = all.map((cls) => {
      if (cls.ownCode !== undefined) return cls.ownCode;
      if (cls.superCode !== undefined && cls.parent !== undefined && descendsFrom(cls.parent, CODE_FROM_FIRST_ARGUMENT)) return cls.superCode;
      return cls.parent === undefined ? undefined : codeOf(cls.parent, seen);
    });
    if (new Set(each).size > 1) throw new CodeReachError(`class ${name} is declared ${all.length} times with different codes (${all.map((cls) => shown(cls.file)).join(', ')})`);
    resolved.set(name, each[0]);
    return each[0];
  };
  const descendsFrom = (name, ancestor) => {
    for (let current = name, steps = 0; current !== undefined && steps < 20; steps += 1) {
      if (current === ancestor) return true;
      current = byName.get(current)?.[0]?.parent;
    }
    return false;
  };
  return { codeOf: (name) => codeOf(name), isClass: (name) => byName.has(name) };
}

let table;
const classes = () => (table ??= classTable(sourceFiles()));

/** The codes a module's own code can throw: its coded constructions, and its DYNAMIC_MODULES entry. */
export function moduleCodes(file) {
  const source = readFileSync(file, 'utf8');
  const code = codeOnly(source);
  const codes = new Set(DYNAMIC_MODULES[shown(file)]?.codes ?? []);
  for (const match of code.matchAll(/\bnew\s+(\w+)\s*\(/g)) {
    const name = match[1];
    if (!classes().isClass(name)) continue;
    const at = match.index + match[0].length;
    const literal = /^\s*['"]/.exec(code.slice(at));
    if (name === CODE_FROM_FIRST_ARGUMENT && literal !== null) {
      codes.add(literalAt(source, at + literal[0].length - 1));
      continue;
    }
    const classCode = name === CODE_FROM_FIRST_ARGUMENT ? 'dynamic' : classes().codeOf(name);
    if (classCode === undefined) continue;
    if (classCode !== 'dynamic') {
      codes.add(classCode);
      continue;
    }
    const entry = DYNAMIC_CLASSES[name];
    if (entry === undefined) throw new CodeReachError(`${shown(file)} constructs ${name}, whose code is not a literal, and DYNAMIC_CLASSES has no entry for it`);
    for (const each of entry.codes) codes.add(each);
  }
  return codes;
}

/** The source file an import names, with its .ts or index.ts filled in; undefined for an outside package or a file that isn't there. */
function sourceOf(file, specifier) {
  const target = importTarget(file, specifier);
  return target === undefined ? undefined : tsSourceOf(target);
}

/**
 * The modules a module reaches directly: the modules its imports that run
 * bring in (through a barrel, the modules defining the names it imports),
 * and the engine its calls reach.
 */
function nextModules(file) {
  const cut = new Set(CUT_IMPORTS.filter(([from]) => fromRoot(from) === file).map(([, to]) => fromRoot(to)));
  // A definition is data: its load() and its tools' checks run only when the shell or the MCP server calls them.
  const isDefinition = file.endsWith('.definition.ts');
  const next = importsOf(file)
    .filter((each) => !each.typeOnly && !(isDefinition && each.dynamic))
    .flatMap((each) => importedModules(file, each)?.modules ?? [])
    .filter((module) => !module.typeOnly)
    .map((module) => tsSourceOf(module.file))
    .filter((target) => target !== undefined && !cut.has(target));
  const code = codeOnly(readFileSync(file, 'utf8'));
  for (const { site, reaches } of ENGINE_SITES) if (site.test(code)) next.push(...reaches.map(fromRoot));
  return next;
}

/**
 * The codes the modules `entries` (paths from the repository's root, or
 * absolute) reach: each code, with the chain of modules from an entry to the
 * first one found throwing it.
 */
export function codeReach(entries) {
  const reached = new Map();
  const via = new Map();
  const pending = entries.map((entry) => resolve(ROOT, entry));
  for (const file of pending) via.set(file, undefined);
  const chain = (file) => (file === undefined ? [] : [...chain(via.get(file)), shown(file)]);
  while (pending.length > 0) {
    const file = pending.shift();
    for (const code of moduleCodes(file)) if (!reached.has(code)) reached.set(code, chain(file));
    for (const next of nextModules(file)) {
      if (via.has(next)) continue;
      via.set(next, file);
      pending.push(next);
    }
  }
  return reached;
}

/**
 * Each command definition's entry modules: its handler, and the shell's payer
 * and protectors when its `shell` asks for them. The definitions are the
 * source files' (`*.definition.ts`), or those of `files`.
 */
export function commandEntries(files = sourceFiles().filter((file) => file.endsWith('.definition.ts'))) {
  return files.map((file) => {
    const source = readFileSync(file, 'utf8');
    const name = /\bname:\s*'([^']+)'/.exec(source)?.[1];
    const load = /\bload:\s*\(\)\s*=>\s*import\('([^']+)'\)/.exec(source)?.[1];
    if (name === undefined || load === undefined) throw new CodeReachError(`${shown(file)}: no command name or load() target found`);
    const shell = /\bshell:\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
    const handler = sourceOf(file, load);
    if (handler === undefined) throw new CodeReachError(`${shown(file)}: its load() target ${load} is not a source file`);
    const provisions = Object.keys(SHELL_PROVISIONS).filter((key) => new RegExp(`\\b${key}:\\s*true`).test(shell));
    return { name, definition: shown(file), handler: shown(handler), provisions, entries: [shown(handler), ...provisions.map((key) => SHELL_PROVISIONS[key])] };
  });
}

/**
 * Where a command's declared codes and its reachable ones part: a reachable
 * code neither declared nor one every command can end with, and a declared
 * code it can't reach.
 */
export function declaredCodeProblems(name, declared, reached, everyCommand) {
  const problems = [];
  for (const [code, chain] of reached) {
    if (!declared.includes(code) && !everyCommand.includes(code)) problems.push(`${name}: reaches ${code} (${chain.join(' → ')}), which it doesn't declare`);
  }
  for (const code of declared) {
    if (!reached.has(code)) problems.push(`${name}: declares ${code}, which none of its modules can throw`);
  }
  return problems;
}

// Run as a script: each command's reachable codes.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  for (const command of commandEntries().sort((a, b) => a.name.localeCompare(b.name))) {
    const reached = codeReach(command.entries);
    process.stdout.write(`${command.name}: ${[...reached.keys()].sort().join(' ')}\n`);
    if (process.argv.includes('--why')) for (const [code, chain] of [...reached].sort()) process.stdout.write(`  ${code}: ${chain.join(' → ')}\n`);
  }
}
