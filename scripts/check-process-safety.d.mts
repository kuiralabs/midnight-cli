// Types for what scripts/check-process-safety.mjs exports when imported.
export const ALLOWED: Record<string, string[]>;
export const ALLOWED_STATE: Record<string, Record<string, string>>;
export function moduleStateDeclarations(code: string): { line: number; name: string }[];
export function findViolations(
  files?: string[],
  allowed?: Record<string, string[]>,
  allowedState?: Record<string, Record<string, string>>,
  src?: string,
): { file: string; line: number; rule: string; name?: string }[];
