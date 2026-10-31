// Types for what scripts/check-process-safety.mjs exports when imported.
export const ALLOWED: Record<string, string[]>;
export function findViolations(files?: string[], allowed?: Record<string, string[]>): { file: string; line: number; rule: string }[];
