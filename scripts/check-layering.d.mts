// Types for what scripts/check-layering.mjs exports when imported.
export function sourceFiles(dir?: string): string[];
export function homeOf(file: string): string | undefined;
export function guidanceRule(fromRel: string, toRel: string): string | undefined;
export function importRule(fromRel: string, toRel: string): string | undefined;
export function findLayeringProblems(): { unhomed: string[]; violations: { home: string; rule: string; where: string; specifier: string }[] };
/** Modules that still import the SDK themselves, until each moves behind the engine. */
export const PENDING_ENGINE: ReadonlySet<string>;
