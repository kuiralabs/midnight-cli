#!/usr/bin/env node
// Each public package's API, as a report checked in beside it: every module a
// program can import through the package's exports map, with the declarations
// it exports (functions, types, classes, constants and their signatures), as
// TypeScript emits them, without comments. An entry point that is a barrel
// (only `export { … } from` lists) shows each name it exports, resolved by the
// type checker to the declaration in the module that defines it. A change to an export shows in the
// report's diff, and the suite fails until the report is written again.
//
// Usage:
//   node scripts/api-report.mjs write    write each package's api-report.md
//   node scripts/api-report.mjs check    exit 1 when a report differs from the code
// Imported, it exports PUBLIC_PACKAGES and apiReport.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { barrelExports } from './check-layering.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The public packages, by folder under packages/. */
export const PUBLIC_PACKAGES = ['cli-core', 'chain', 'engine-rc', 'engine-beta', 'wallet', 'contract', 'connect', 'dev', 'grant'];

/** The report's path for the package in `dir` (a folder under packages/). */
export function reportPath(dir) {
  return join(ROOT, 'packages', dir, 'api-report.md');
}

/**
 * The entry points the exports map lets a program import, as [subpath, source
 * file] pairs: a subpath pattern (`./*`) stands for every source module it matches.
 */
function entryModules(pkgDir, srcFiles) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const entries = new Map();
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    const source = typeof target === 'string' ? target : target['midnight-cli-source'];
    if (typeof source !== 'string') throw new Error(`${pkg.name}: export ${subpath} names no source module`);
    if (!subpath.includes('*')) {
      entries.set(subpath, join(pkgDir, source));
      continue;
    }
    const [before, after] = source.split('*');
    const prefix = join(pkgDir, before);
    for (const file of srcFiles) {
      if (!file.startsWith(prefix) || !file.endsWith(after)) continue;
      const stem = file.slice(prefix.length, file.length - after.length);
      entries.set(subpath.replace('*', stem), file);
    }
  }
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The package's declarations, emitted in memory, by source file. */
function emitDeclarations(pkgDir) {
  const configPath = join(pkgDir, 'tsconfig.build.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: false, emitDeclarationOnly: true, declaration: true, declarationMap: false, sourceMap: false }, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const declarations = new Map();
  const outDir = parsed.options.outDir;
  const rootDir = parsed.options.rootDir;
  const result = program.emit(undefined, (fileName, text) => {
    if (!fileName.endsWith('.d.ts')) return;
    const source = join(rootDir, relative(outDir, fileName)).replace(/\.d\.ts$/, '.ts');
    declarations.set(source, text);
  }, undefined, true);
  const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => pkgDir, getNewLine: () => '\n' }));
  return { program, declarations, srcFiles: parsed.fileNames };
}

const DECLARATION_KINDS = [ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration, ts.SyntaxKind.ModuleDeclaration];

/**
 * The statements of an emitted declaration file that declare `name` (a
 * function's overloads, a merged interface's parts), or the re-export of it
 * from another package.
 */
function statementsDeclaring(text, name) {
  const file = ts.createSourceFile('x.d.ts', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found = file.statements.filter((statement) => {
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name);
    return DECLARATION_KINDS.includes(statement.kind) && statement.name?.text === name;
  });
  if (found.length > 0) return found.map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, file));
  const reExport = file.statements.find((statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some((element) => element.name.text === name));
  return reExport === undefined ? [] : [`export ${reExport.isTypeOnly ? 'type ' : ''}{ ${name} } from ${reExport.moduleSpecifier.getText(file)};`];
}

/**
 * The declarations a barrel exports, walked with the type checker: each name
 * resolved to the module that defines it, and printed from that module's
 * emitted declarations, in the barrel's order.
 */
function barrelDeclarations(program, declarations, barrel) {
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(barrel));
  const printed = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (symbol.name !== exported.name) throw new Error(`${relative(ROOT, barrel)} exports ${symbol.name} as ${exported.name}: a barrel re-exports each name as it is`);
    // A name another package defines is shown as re-exported by the module the barrel lists.
    const declared = symbol.declarations?.[0]?.getSourceFile().fileName;
    const definer = declarations.has(declared) ? declared : barrelExports(barrel).get(exported.name)?.file;
    const text = definer === undefined ? undefined : declarations.get(definer);
    const statements = text === undefined ? [] : statementsDeclaring(text, symbol.name);
    if (statements.length === 0) throw new Error(`${relative(ROOT, barrel)}: no declaration found for ${exported.name}`);
    printed.push(...statements);
  }
  return printed.join('\n');
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** Declarations without comments, printed the same way whatever their source's layout. */
function normalise(text) {
  const file = ts.createSourceFile('x.d.ts', text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
  return printer.printFile(file).replace(/^export \{\};\n?/m, '').trim();
}

/** The report of the package in `dir` (a folder under packages/). */
export function apiReport(dir) {
  const pkgDir = join(ROOT, 'packages', dir);
  const name = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name;
  const { program, declarations, srcFiles } = emitDeclarations(pkgDir);
  let report = `# API report: ${name}\n\nGenerated by \`node scripts/api-report.mjs write\` from the code: every entry point the exports map makes importable, with what it exports. Don't edit it by hand.\n`;
  for (const [subpath, source] of entryModules(pkgDir, srcFiles)) {
    const text = declarations.get(source);
    if (text === undefined) throw new Error(`${name}: export ${subpath} has no declarations (${relative(ROOT, source)})`);
    const body = barrelExports(source) === undefined ? normalise(text) : barrelDeclarations(program, declarations, source);
    report += `\n## \`${name}${subpath === '.' ? '' : subpath.slice(1)}\`\n\n` + (body === '' ? '(exports nothing)\n' : '```ts\n' + body + '\n```\n');
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  if (mode !== 'write' && mode !== 'check') {
    console.error('Usage: node scripts/api-report.mjs <write|check>');
    process.exit(2);
  }
  let differs = 0;
  for (const dir of PUBLIC_PACKAGES) {
    const report = apiReport(dir);
    const path = reportPath(dir);
    if (mode === 'write') {
      writeFileSync(path, report);
      console.log(`wrote ${relative(ROOT, path)}`);
      continue;
    }
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { /* missing: differs */ }
    if (current !== report) {
      differs += 1;
      console.error(`${relative(ROOT, path)} differs from the code: run node scripts/api-report.mjs write and review the diff`);
    }
  }
  process.exit(differs === 0 ? 0 : 1);
}
