// Types for what scripts/check-layering.mjs exports when imported.
export function sourceFiles(dir?: string): string[];
export function homeOf(file: string): string | undefined;
export function guidanceRule(fromRel: string, toRel: string): string | undefined;
export function importRule(fromRel: string, toRel: string): string | undefined;
export function findLayeringProblems(): { unhomed: string[]; violations: { home: string; rule: string; where: string; specifier: string }[] };

/** The workspace packages carved out of src/: their names and source folders. */
export const WORKSPACE_PACKAGES: readonly { name: string; dir: string; prefix?: string }[];
/** A file's path as the homes read it: under its package's source folder, or under src/. */
export function relOf(file: string): string;
/** A file's imports: each specifier, its line, whether it is an `import()`, and whether it brings in types alone. */
export function importsOf(file: string): { specifier: string; line: number; dynamic: boolean; typeOnly: boolean }[];
/** The source file an import of `file` names; undefined for an outside package. */
export function importTarget(file: string, specifier: string): string | undefined;
