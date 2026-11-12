// A compiled contract's constructor parameters. contract-info.json lists the
// circuits' arguments but not the constructor's; the compiler's declaration
// of the contract (managed/<name>/contract/index.d.ts) gives them, after the
// context midnight-js passes first:
//   initialState(context: __compactRuntime.ConstructorContext<PS>, start_0: bigint): ...
// The compiler suffixes each name with `_<n>`; the name is the Compact one
// without it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const INITIAL_STATE = /\binitialState\(([^)]*)\)/;

/**
 * The constructor's parameter names, in order, from the declaration under
 * `managedDir` (the managed/<name>/ folder); undefined when there is no
 * declaration or it has no initialState to read.
 */
export function constructorParametersOf(managedDir: string): string[] | undefined {
  const declaration = join(managedDir, 'contract', 'index.d.ts');
  if (!existsSync(declaration)) return undefined;
  const signature = INITIAL_STATE.exec(readFileSync(declaration, 'utf-8'));
  if (!signature) return undefined;
  // Top-level commas only: a parameter's type can hold its own (a generic's, a tuple's).
  const parameters: string[] = [];
  let depth = 0;
  let current = '';
  const text = signature[1]!;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '<' || ch === '[' || ch === '{' || ch === '(') depth++;
    // The `>` of a function type's `=>` closes nothing.
    else if ((ch === '>' && text[i - 1] !== '=') || ch === ']' || ch === '}' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { parameters.push(current); current = ''; } else current += ch;
  }
  if (current.trim() !== '') parameters.push(current);
  // The first is midnight-js's context.
  return parameters.slice(1).map((parameter) => parameter.split(':')[0]!.trim().replace(/_\d+$/, ''));
}
