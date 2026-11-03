// Types for what scripts/api-report.mjs exports when imported.
/** The public packages, by folder under packages/. */
export const PUBLIC_PACKAGES: readonly string[];
/** The report's path for the package in `dir` (a folder under packages/). */
export function reportPath(dir: string): string;
/** The report of the package in `dir` (a folder under packages/). */
export function apiReport(dir: string): string;
