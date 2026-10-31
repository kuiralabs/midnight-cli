#!/usr/bin/env node
// Checks that library code leaves the host process alone (spec §3.1, decision
// 20): no writing to the terminal, exiting, installing process handlers,
// patching console, changing directory, opening a prompt, reading the
// environment, or computing a path from the home directory (spec §7). Commands, ui/, the shell and the MCP server may; so may the
// modules marked below as shell concerns. String and template-literal
// contents and comments are skipped, so the contract runner's generated
// scripts (which run as their own process) don't count.
//
// Usage: node scripts/check-process-safety.mjs
// Exits 1 when a library does something §3.1 forbids and the allowlist
// doesn't name it. Imported, it exports findViolations.

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

function isLibrary(file) {
  const rel = relative(SRC, file);
  if (rel.startsWith('commands/') || rel.startsWith('ui/') || rel.startsWith('__tests__/')) return false;
  if (['shell', 'mcp'].includes(homeOf(file))) return false;
  return !SHELL_CONCERNS.has(rel);
}

/** Every §3.1 break in library code that the allowlist doesn't name: { file, line, rule }. */
export function findViolations(files = sourceFiles(), allowed = ALLOWED) {
  const found = [];
  for (const file of files.filter(isLibrary)) {
    const rel = relative(SRC, file);
    const source = readFileSync(file, 'utf8');
    const lines = codeOnly(source).split('\n');
    // An import line keeps its specifier: check prompts on the raw source.
    const raw = source.split('\n');
    for (const [rule, pattern] of RULES) {
      if ((allowed[rel] ?? []).includes(rule)) continue;
      // A rule matched on a string (an import's specifier, stdio's 'inherit') reads the raw source.
      const scan = RAW_RULES.has(rule) ? raw : lines;
      scan.forEach((text, at) => {
        if (pattern.test(text) && !(RAW_RULES.has(rule) && /^\s*(\/\/|\*)/.test(text))) found.push({ file: rel, line: at + 1, rule });
      });
    }
  }
  return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const found = findViolations();
  for (const v of found) process.stdout.write(`src/${v.file}:${v.line}  ${v.rule}\n`);
  const allowedCount = Object.keys(ALLOWED).length;
  process.stdout.write(`\n${found.length === 0 ? 'Libraries leave the process alone' : `${found.length} place(s) where a library touches the process`}${allowedCount > 0 ? ` (${allowedCount} file(s) allowed, with their reasons)` : ''}.\n`);
  process.exit(found.length === 0 ? 0 : 1);
}
