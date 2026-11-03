// Error codes, owned per package: each package defines the codes its errors
// carry (in its <package>.codes.ts, beside its guidance), with the exit code
// each ends the CLI with, and the shell assembles the installed packages'
// codes into one lookup, refusing a code two packages define. classifyError
// reads an error's `code` through that lookup.

/** One error code: what `--json` and MCP report as `code`, and the CLI's exit code for it. */
export interface CodeDefinition {
  readonly code: string;
  readonly exitCode: number;
  /** What went wrong: the meaning the code tables give it (the manuals', the full skill's, docs/JSON_CONTRACT.md's). */
  readonly summary: string;
  /** What an agent does about it: the full skill's recovery recipe. */
  readonly recovery?: string;
  /** Its place in the code tables: rows read in ascending order. A code shown to agents needs it (codeGuidancePieces). */
  readonly order?: number;
}

/** The codes known where an error is classified: the definition of a code, or undefined for one no installed package defines. */
export interface CodeRegistry {
  code(code: string): CodeDefinition | undefined;
}

/** Thrown when a package's codes contradict themselves: one code defined twice. */
export class CodeDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeDefinitionError';
    Object.setPrototypeOf(this, CodeDefinitionError.prototype);
  }
}

/** A package's codes, as it exports them; refuses a code it defines twice. */
export function defineCodes<const T extends readonly CodeDefinition[]>(codes: T): T {
  const seen = new Set<string>();
  for (const { code } of codes) {
    if (seen.has(code)) throw new CodeDefinitionError(`Error code "${code}" is defined twice`);
    seen.add(code);
  }
  return codes;
}
