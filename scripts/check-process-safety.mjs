#!/usr/bin/env node
// Checks that library code leaves the host process alone (spec §3.1, decision
// 20): no writing to the terminal, exiting, installing process handlers,
// patching console, changing directory, opening a prompt, reading the
// environment, or computing a path from the home directory (spec §7). Commands, ui/, the shell and the MCP server may; so may the
// modules marked below as shell concerns. String and template-literal
// contents and comments are skipped, so the contract runner's generated
// scripts (which run as their own process) don't count.
//
// And that nothing about a call lives in module globals (spec §4.4, D21, 2F):
//   - library, ui and command code keeps no mutable state at module level (a
//     `let` or `var`, or a Map, Set or array that isn't typed readonly, or an
//     empty object to fill); what is shared on purpose is allowlisted by name,
//     with its reason;
//   - only the shell sets the process's exit code; a handler returns its own;
//   - only the shell's noise filter (lib/sdk-noise.ts) may keep ambient per-call
//     storage (AsyncLocalStorage, async_hooks); everything else is passed the
//     call's context explicitly.
//
// Usage: node scripts/check-process-safety.mjs
// Exits 1 when a library does something §3.1 forbids, or any code breaks the
// 2F rules, and the allowlist doesn't name it. Imported, it exports
// findViolations.

import { readFileSync } from 'node:fs';
import { relative, resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homeOf, sourceFiles } from './check-layering.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

const RULES = [
  ['writes to the terminal', /\bprocess\.(stdout|stderr)\.write\s*\(|\bconsole\.(log|error|warn|info|debug)\s*\(/],
  ['exits', /\bprocess\.exit\s*\(/],
  ['installs a process handler', /\bprocess\.(on|once|addListener|prependListener)\s*\(/],
  ['patches console or stdout', /\bconsole\.(log|error|warn|info|debug)\s*=[^=]|\bprocess\.(stdout|stderr)\.write\s*=[^=]/],
  ['changes directory', /\bprocess\.chdir\s*\(/],
  ['opens a prompt', /\bfrom\s+['"](node:)?readline['"]|\brequire\(\s*['"](node:)?readline['"]\s*\)/],
  ['reads the environment', /\bprocess\.env\b/],
  ['reads the terminal', /\bprocess\.stdin\b|\bsetRawMode\s*\(/],
  ['hands a child the terminal', /\bstdio\s*:\s*['"]inherit['"]|['"]inherit['"]/],
  // Spec §7: the host gives the state root; a library never builds a path from the home directory.
  ['computes a path from the home directory', /\bhomedir\s*\(|\bos\.homedir\b/],
];

const RAW_RULES = new Set(['opens a prompt', 'hands a child the terminal']);

// The 2F rules, each with the code it applies to.
const MODULE_STATE = 'keeps module state';
const STALE_STATE = 'allowlists module state it no longer keeps';
const AMBIENT = 'keeps ambient per-call storage';
const notNoiseFilter = (file) => relative(SRC, file) !== 'lib/sdk-noise.ts';
// [rule, pattern, the files it applies to, whether it reads the raw source (an import's specifier)].
const CALL_RULES = [
  // Only the shell turns a handler's exit code into the process's.
  ['sets the process exit code', /\bprocess\.exitCode\s*(=[^=]|\?\?=|\|\|=)/, (file) => homeOf(file) !== 'shell', false],
  // Ambient per-call storage is module state in disguise: only the shell's noise filter may attribute the SDK's noise that way.
  [AMBIENT, /\bAsyncLocalStorage\b/, notNoiseFilter, false],
  [AMBIENT, /\bfrom\s+['"](node:)?async_hooks['"]|\brequire\(\s*['"](node:)?async_hooks['"]\s*\)/, notNoiseFilter, true],
];

// Shell concerns by design (1F): what they do to the process is their job.
const SHELL_CONCERNS = new Set([
  'lib/json-output.ts', // the --json output channel
]);

// What a library may still do, and why. Each entry is file → rules it may
// break; each needs a reason a library can't do otherwise.
export const ALLOWED = {
  // Hands the environment on to the script it generates, which runs as its own
  // process and reads MN_INDEXER_URL and the private-state secret from it; and,
  // only when mn runs under a runtime other than Node, reads PATH to find Node.
  'lib/contract/runner.ts': ['reads the environment'],
};

// Module-level state that the 2F rule allows, by file and name, and why. A
// call's state is allowed only until the step of 2F that moves it into the
// call's context; what is shared on purpose holds no call's state.
export const ALLOWED_STATE = {
  // Shared on purpose: none holds a call's state.
  'lib/passphrase.ts': { unlocked: 'shared on purpose: the passphrase this process has unlocked, by state root (one prompt per run)' },
  'lib/wallet-data-repository.ts': { defaultRepo: 'shared on purpose: the wallet repository, whose cache long-lived MCP sessions share across calls' },
  'lib/chain-id.ts': { CHAIN_ID_MEMO: 'shared on purpose: the chain-id memo, by endpoint' },
  'lib/ws-rpc.ts': { connectionCounter: 'shared on purpose: the RPC connection id counter, unique across servers in the process' },
  'lib/wallet-config.ts': { warnedPlain: 'shared on purpose: each plain-text wallet is warned about once per run' },
  // The host sources, set once by the host at start (decision 1: host-set until phase 3; handlers see them through the context).
  'lib/settings.ts': { source: 'shared on purpose: the host sets the settings source once' },
  'lib/state-root.ts': { source: 'shared on purpose: the host sets the paths source once' },
  'lib/notices.ts': { sink: 'shared on purpose: the host sets the notice sink once' },
  'lib/prompter.ts': { current: 'shared on purpose: the host sets the prompter once' },
};

/**
 * Replaces string, template-literal text, regex-literal and comment contents
 * with spaces, keeping line breaks. The code inside a template's `${…}` is
 * kept and scanned like any other code.
 */
function codeOnly(source) {
  let out = '';
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  // Where a '/' starts a regex literal rather than a division: after nothing,
  // or after an operator or an opening bracket.
  const regexMayStart = () => /(^|[=(,;:!&|?{}[+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(out);
  // Inside templates, the `${…}` depth at which each one was opened.
  const templates = [];
  let depth = 0;
  const skipTemplateText = () => {
    // At a template's text: blank it until its end or the next `${`.
    let j = i;
    while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
    out += blank(source.slice(i, j));
    i = j;
    if (source[i] === '`') { out += '`'; i += 1; templates.pop(); }
    else if (i < source.length) { out += '${'; i += 2; depth += 1; }
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (c === '`') {
      out += '`';
      i += 1;
      templates.push(depth);
      skipTemplateText();
    } else if (c === '}' && templates.length > 0 && depth === templates[templates.length - 1] + 1) {
      // The end of a template's `${…}`: back to its text.
      out += '}';
      i += 1;
      depth -= 1;
      skipTemplateText();
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += c + blank(source.slice(i + 1, j)) + (source[j] === c ? c : '');
      i = source[j] === c ? j + 1 : j;
    } else if (c === '/' && regexMayStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j += 1;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j += 1;
      }
      out += '/' + blank(source.slice(i + 1, j)) + (source[j] === '/' ? '/' : '');
      i = source[j] === '/' ? j + 1 : j;
    } else {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * The module-level declarations in `code` (as codeOnly leaves it) that hold
 * mutable state: { line, name }. A `let` or `var`; a `const` made with
 * `new Map/Set/WeakMap/WeakSet/Array` unless typed ReadonlyMap/ReadonlySet;
 * an array literal unless typed readonly or `as const`; an empty object
 * literal unless typed Readonly. A non-empty object literal is a table of
 * constants, not state.
 */
export function moduleStateDeclarations(code) {
  const found = [];
  let depth = 0;
  let lineStart = 0;
  let lineNumber = 1;
  for (let i = 0; i <= code.length; i += 1) {
    if (i === code.length || code[i] === '\n') {
      lineNumber += 1;
      lineStart = i + 1;
      continue;
    }
    const c = code[i];
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    if (depth !== 0 || i !== lineStart) continue;
    const head = /^\s*(?:export\s+)?(?:declare\s+)?(let|var|const)\s+([A-Za-z_$][\w$]*)/.exec(code.slice(i, code.indexOf('\n', i) === -1 ? code.length : code.indexOf('\n', i)));
    if (head === null) continue;
    const statement = topLevelStatement(code, i);
    const [, kind, name] = head;
    if (kind !== 'const' || isMutableInitializer(statement.slice(head[0].length))) found.push({ line: lineNumber, name });
  }
  return found;
}

/** The statement starting at `start`: up to its first `;` outside brackets, or the end. */
function topLevelStatement(code, start) {
  let depth = 0;
  for (let j = start; j < code.length; j += 1) {
    const c = code[j];
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    else if (c === ';' && depth === 0) return code.slice(start, j);
  }
  return code.slice(start);
}

/** After a const's name: its type annotation and initializer hold mutable state. */
function isMutableInitializer(rest) {
  // The initializer's `=`: the first outside brackets, not part of `=>`, `==`.
  let depth = 0;
  let at = -1;
  for (let j = 0; j < rest.length; j += 1) {
    const c = rest[j];
    if (c === '=' && rest[j + 1] === '>') { j += 1; continue; }
    if ('{[(<'.includes(c)) depth += 1;
    else if ('}])>'.includes(c)) depth -= 1;
    else if (c === '=' && depth === 0 && rest[j + 1] !== '=') { at = j; break; }
  }
  if (at === -1) return false;
  const type = rest.slice(0, at).replace(/^\s*:\s*/, '').trim();
  const init = rest.slice(at + 1).trim();
  if (/^new\s+(Map|Set|WeakMap|WeakSet|Array)\b/.test(init)) return !/^Readonly(Map|Set)\b/.test(type);
  if (init.startsWith('[')) return !(/\breadonly\b|\bReadonlyArray\s*</.test(type) || /\]\s*as\s+const\b/.test(init));
  if (/^\{\s*\}/.test(init)) return !/^Readonly\s*</.test(type);
  return false;
}

/** Library, ui and command code: where module state is a call's state waiting to mix. */
function keepsCallsApart(file) {
  const rel = relative(SRC, file);
  if (rel.startsWith('__tests__/')) return false;
  return !['shell', 'mcp'].includes(homeOf(file));
}

function isLibrary(file) {
  const rel = relative(SRC, file);
  if (rel.startsWith('commands/') || rel.startsWith('ui/') || rel.startsWith('__tests__/')) return false;
  if (['shell', 'mcp'].includes(homeOf(file))) return false;
  return !SHELL_CONCERNS.has(rel);
}

/**
 * Every §3.1 break in library code, and every 2F break, that the allowlists
 * don't name: { file, line, rule }, and the name for module state.
 */
export function findViolations(files = sourceFiles(), allowed = ALLOWED, allowedState = ALLOWED_STATE) {
  const found = [];
  for (const file of files) {
    const rel = relative(SRC, file);
    const source = readFileSync(file, 'utf8');
    const code = codeOnly(source);
    const lines = code.split('\n');
    // An import line keeps its specifier: check prompts on the raw source.
    const raw = source.split('\n');
    const scanRule = (rule, pattern, isRaw) => {
      if ((allowed[rel] ?? []).includes(rule)) return;
      // A rule matched on a string (an import's specifier, stdio's 'inherit') reads the raw source.
      const scan = isRaw ? raw : lines;
      scan.forEach((text, at) => {
        if (pattern.test(text) && !(isRaw && /^\s*(\/\/|\*)/.test(text))) found.push({ file: rel, line: at + 1, rule });
      });
    };
    if (isLibrary(file)) {
      for (const [rule, pattern] of RULES) scanRule(rule, pattern, RAW_RULES.has(rule));
    }
    if (keepsCallsApart(file)) {
      const declared = moduleStateDeclarations(code);
      for (const { line, name } of declared) {
        if (!Object.hasOwn(allowedState[rel] ?? {}, name)) found.push({ file: rel, line, rule: MODULE_STATE, name });
      }
      // An entry whose state is gone goes too, so the allowlist never outlives what it allows.
      for (const name of Object.keys(allowedState[rel] ?? {})) {
        if (!declared.some((d) => d.name === name)) found.push({ file: rel, line: 0, rule: STALE_STATE, name });
      }
    }
    for (const [rule, pattern, appliesTo, isRaw] of CALL_RULES) {
      if (appliesTo(file) && !rel.startsWith('__tests__/')) scanRule(rule, pattern, isRaw);
    }
  }
  // One finding per line and rule, however many of its patterns match there.
  return found.filter((v, at) => found.findIndex((w) => w.file === v.file && w.line === v.line && w.rule === v.rule && w.name === v.name) === at);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const found = findViolations();
  for (const v of found) process.stdout.write(`src/${v.file}:${v.line}  ${v.rule}${v.name === undefined ? '' : ` (${v.name})`}\n`);
  const allowedCount = Object.keys(ALLOWED).length;
  const stateCount = Object.values(ALLOWED_STATE).reduce((n, names) => n + Object.keys(names).length, 0);
  process.stdout.write(`\n${found.length === 0 ? 'Libraries leave the process alone, and no call keeps its state in a module' : `${found.length} place(s) where code touches the process or keeps a call's state`} (${allowedCount} file(s) and ${stateCount} module state(s) allowed, with their reasons).\n`);
  process.exit(found.length === 0 ? 0 : 1);
}
