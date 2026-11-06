// Types for what scripts/check-process-safety.mjs exports when imported.
/** Core's host-called process directory: what only a host calls, on its own process. */
export const CORE_PROCESS_DIR: string;
export const ALLOWED: Record<string, string[]>;
export const ALLOWED_STATE: Record<string, Record<string, string>>;
export const ALLOWED_SETTERS: Record<string, Record<string, string>>;
export function moduleStateDeclarations(code: string): { line: number; name: string; kind: 'let' | 'var' | 'const' }[];
export function exportedSetters(code: string): { line: number; name: string }[];
export function findViolations(
  files?: string[],
  allowed?: Record<string, string[]>,
  allowedState?: Record<string, Record<string, string>>,
  src?: string,
  allowedSetters?: Record<string, Record<string, string>>,
): { file: string; line: number; rule: string; name?: string }[];
/** The source with string, template-text, regex and comment contents blanked, every offset and line kept. */
export function codeOnly(source: string): string;
