// Types for what scripts/code-reach.mjs exports when imported.

/** A site whose code is not a literal in the code: the codes it can carry, and why. */
export interface DynamicSite {
  readonly codes: readonly string[];
  readonly why: string;
}

export class CodeReachError extends Error {}
export const DYNAMIC_CLASSES: Readonly<Record<string, DynamicSite>>;
export const DYNAMIC_MODULES: Readonly<Record<string, DynamicSite>>;
export const ENGINE_PARTS: Readonly<Record<'keys' | 'ledger' | 'contracts' | 'readers' | 'wallet', readonly string[]>>;
export const ENGINE_SITES: readonly { readonly site: RegExp; readonly reaches: readonly string[] }[];
export const CUT_IMPORTS: readonly (readonly [from: string, to: string])[];
export const SHELL_PROVISIONS: Readonly<Record<'payer' | 'protectors', string>>;
export const CATCHING_PROVISIONS: Readonly<Partial<Record<'payer' | 'protectors', string>>>;
/** The codes a module's own code can throw. */
export function moduleCodes(file: string): Set<string>;
/** The codes the entry modules reach: each, with the chain of modules from an entry to the first one throwing it. */
export function codeReach(entries: readonly string[]): Map<string, string[]>;
/** Each command definition's entry modules (paths from the repository's root). */
export function commandEntries(files?: readonly string[]): { name: string; definition: string; handler: string; provisions: ('payer' | 'protectors')[]; entries: string[] }[];
/** Where a command's declared codes and its reachable ones part. */
export function declaredCodeProblems(name: string, declared: readonly string[], reached: ReadonlyMap<string, readonly string[]>, everyCommand: readonly string[]): string[];
