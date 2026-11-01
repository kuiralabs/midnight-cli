// Types for what scripts/check-layering.mjs exports when imported.
export function sourceFiles(dir?: string): string[];
export function homeOf(file: string): string | undefined;
export function guidanceRule(fromRel: string, toRel: string): string | undefined;
