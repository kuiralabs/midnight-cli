// Types for what scripts/check-layering.mjs exports when imported.
export function sourceFiles(dir?: string): string[];
export function homeOf(file: string): string | undefined;
export function guidanceRule(fromRel: string, toRel: string): string | undefined;
export function importRule(fromRel: string, toRel: string): string | undefined;
export function findLayeringProblems(): { unhomed: string[]; violations: { home: string; rule: string; where: string; specifier: string }[] };

/** The workspace packages carved out of src/: their names and source folders. */
export const WORKSPACE_PACKAGES: readonly { name: string; dir: string }[];
/** A file's path as the homes read it: under its package's source folder, or under src/. */
export function relOf(file: string): string;
