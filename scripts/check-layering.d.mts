// Types for what scripts/check-layering.mjs exports when imported.
export function sourceFiles(dir?: string): string[];
export function homeOf(file: string): string | undefined;
export function guidanceRule(fromRel: string, toRel: string): string | undefined;
export function importRule(fromRel: string, toRel: string): string | undefined;
export function findLayeringProblems(): { unhomed: string[]; violations: { home: string; rule: string; where: string; specifier: string }[] };
/** The imports of a test file that break a rule: a test imports its own package relatively, every other by an entry point. */
export function testProblems(file: string): { home: string; rule: string; where: string; specifier: string }[];
/** The TypeScript files of every `__tests__` folder, the layering check's own fixtures left out. */
export function testFiles(): string[];
/** The TypeScript files of test-support/. */
export function testSupportFiles(): string[];
/** The imports of a test-support file that break a rule: packages by entry point only, and of mn's code only lib/installed-engines.ts. */
export function testSupportProblems(file: string): { home: string; rule: string; where: string; specifier: string }[];
/** The repository's scripts (scripts/*.ts and *.mjs), those the scan leaves out (with why) excepted. */
export function scriptFiles(): string[];

/** The workspace packages carved out of src/: their names and source folders. */
export const WORKSPACE_PACKAGES: readonly { name: string; root: string; dir: string; prefix?: string; home: string }[];
/** The entry points a workspace package's exports map lists. */
export function entryPoints(pkg: { name: string; root: string }): string[];
/** The source file a workspace package's subpath names through its exports map; undefined when the map lacks it. */
export function entrySource(pkg: { name: string; root: string }, subpath: string): string | undefined;
/** A file's path as the homes read it: under its package's source folder, or under src/. */
export function relOf(file: string): string;
/** A name an import brings in, and whether it is a type alone. */
export interface ImportedName { name: string; typeOnly: boolean }
/** An import of a file. */
export interface FileImport { specifier: string; line: number; dynamic: boolean; typeOnly: boolean; names: ImportedName[] | null }
/** A file's imports: each specifier, its line, whether it is an `import()`, whether it brings in types alone, and the names it brings in (null for a whole module). */
export function importsOf(file: string): FileImport[];
/** The source file an import of `file` names; undefined for an outside package, or a subpath a workspace package's exports map lacks. */
export function importTarget(file: string, specifier: string): string | undefined;
/** The TypeScript source an import's target is, with its .ts or index.ts filled in; undefined for a file that isn't there. */
export function tsSourceOf(target: string): string | undefined;
/** A barrel's re-exports (exported name → the module defining it and its name there); undefined for a module that is not a barrel. */
export function barrelExports(file: string): Map<string, { file: string; name: string; typeOnly: boolean }> | undefined;
/** The modules an import brings in (through a barrel, the modules defining its names); { refused } for a deep import; undefined for an outside package. */
export function importedModules(file: string, imported: Pick<FileImport, 'specifier' | 'typeOnly' | 'names'>): { modules: { file: string; typeOnly: boolean }[]; refused?: undefined } | { refused: string[]; modules?: undefined } | undefined;
