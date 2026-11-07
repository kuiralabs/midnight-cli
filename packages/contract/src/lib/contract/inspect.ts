// Contract inspector — parse Compact compiler output (contract-info.json) to discover
// circuits, parameters, witnesses, and types for any compiled Midnight contract.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

// ── Types ──

export interface CompactType {
  'type-name': string;
  length?: number;
  maxval?: number;
  tsType?: string;
  types?: CompactType[];
}

export interface CircuitInfo {
  name: string;
  pure: boolean;
  proof: boolean;
  arguments: { name: string; type: CompactType }[];
  'result-type': CompactType;
}

export interface WitnessInfo {
  name: string;
  arguments: { name: string; type: CompactType }[];
  'result type': CompactType;
}

export interface ContractInfo {
  name: string;
  managedDir: string;
  compilerVersion: string;
  languageVersion: string;
  runtimeVersion: string;
  circuits: CircuitInfo[];
  witnesses: WitnessInfo[];
  /** Other contract names found alongside this one in the same managed/ dir. Empty when single-contract. */
  siblings: string[];
}

// ── Discovery ──

const CONTRACT_INFO_FILENAME = 'contract-info.json';

// Candidate subdirectories that may contain a `managed/` directory. Order
// matters only for tie-breaking; the first match wins. Includes both
// `contract/` (singular — original midnight-libraries layout) and
// `contracts/` (plural — used by create-mn-app's hello-world template and
// many community projects). Without the plural variant, those projects
// silently miss our scan and force users into `--managed`.
const SCAN_CANDIDATES = [
  '',
  'contract/src',
  'contract',
  'contracts/src',
  'contracts',
  'src',
] as const;

/**
 * Find contract-info.json by scanning for managed/<name>/compiler/contract-info.json.
 * Searches the given directory and common subdirectories (contract/src, contracts/src, src).
 *
 * If `contractName` is given, only returns that specific contract (errors if not found).
 * Otherwise returns the first contract discovered alphabetically; siblings are populated
 * with the other contract names so callers can offer disambiguation.
 */
export function findContractInfo(startDir: string, contractName?: string): { info: ContractInfo; infoPath: string } {
  // Try direct managed dir first (--managed flag points at managed/<name>/)
  const directPath = join(startDir, 'compiler', CONTRACT_INFO_FILENAME);
  if (existsSync(directPath)) {
    return loadContractInfo(directPath, startDir, []);
  }

  for (const sub of SCAN_CANDIDATES) {
    const managedDir = sub ? join(startDir, sub, 'managed') : join(startDir, 'managed');
    if (!existsSync(managedDir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(managedDir).sort();
    } catch {
      continue;
    }

    // Filter to only entries with a real contract-info.json
    const present = entries.filter((entry) =>
      existsSync(join(managedDir, entry, 'compiler', CONTRACT_INFO_FILENAME))
    );
    if (present.length === 0) continue;

    let chosen: string;
    if (contractName) {
      if (!present.includes(contractName)) {
        throw new Error(
          `Contract "${contractName}" not found in ${managedDir}\n` +
          `Available: ${present.join(', ')}`
        );
      }
      chosen = contractName;
    } else {
      chosen = present[0];
    }

    const siblings = present.filter((n) => n !== chosen);
    const infoPath = join(managedDir, chosen, 'compiler', CONTRACT_INFO_FILENAME);
    return loadContractInfo(infoPath, join(managedDir, chosen), siblings);
  }

  throw new ContractNotCompiledError(
    `No compiled contract found in ${startDir}\n` +
    `Expected: managed/<name>/compiler/${CONTRACT_INFO_FILENAME}\n` +
    `Searched: ${SCAN_CANDIDATES.map((s) => s ? `${s}/managed/` : 'managed/').join(', ')}\n` +
    `Run "compact compile" first, or use --managed <path> to specify the managed directory.`
  );
}

function loadContractInfo(infoPath: string, managedDir: string, siblings: string[]): { info: ContractInfo; infoPath: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(infoPath, 'utf-8'));
  } catch (err) {
    throw new ContractInfoInvalidError(infoPath, [`it is not JSON (${(err as Error).message})`]);
  }

  const info = parseContractInfo(raw, infoPath, managedDir, siblings);
  return { info, infoPath };
}

// ── Parsing & Validation ──

function parseContractInfo(raw: unknown, path: string, managedDir: string, siblings: string[]): ContractInfo {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ContractInfoInvalidError(path, ['it is not a JSON object']);
  }

  const obj = raw as Record<string, unknown>;

  // Older Compact compilers (pre-0.30) omit the version trio. Default to
  // 'unknown' so the contract is still inspectable; the user sees the gap
  // explicitly in the rendered output rather than a hard parse error.
  const compilerVersion = typeof obj['compiler-version'] === 'string' ? (obj['compiler-version'] as string) : 'unknown';
  const languageVersion = typeof obj['language-version'] === 'string' ? (obj['language-version'] as string) : 'unknown';
  const runtimeVersion = typeof obj['runtime-version'] === 'string' ? (obj['runtime-version'] as string) : 'unknown';

  // Every compiler writes both lists, empty or not: without them the file is
  // no compiler's, and reading it on would fail later with a raw TypeError.
  const problems = [...listProblems(obj, 'circuits', circuitProblems), ...listProblems(obj, 'witnesses', witnessProblems)];
  if (problems.length > 0) throw new ContractInfoInvalidError(path, problems);
  const circuits = obj.circuits as CircuitInfo[];
  const witnesses = obj.witnesses as WitnessInfo[];

  // Derive contract name from the managed directory name
  const name = basename(managedDir);

  return {
    name,
    managedDir,
    compilerVersion,
    languageVersion,
    runtimeVersion,
    circuits,
    witnesses,
    siblings,
  };
}

// ── Type Formatting ──

/**
 * Format a Compact type to a human-readable TypeScript-like string.
 */
export function formatCompactType(type: CompactType): string {
  switch (type['type-name']) {
    case 'Uint':
      return 'bigint';
    case 'Bytes':
      return 'Uint8Array';
    case 'Opaque':
      return type.tsType ?? 'unknown';
    case 'Tuple':
      if (!type.types || type.types.length === 0) return 'void';
      return `[${type.types.map(formatCompactType).join(', ')}]`;
    case 'Boolean':
      return 'boolean';
    case 'String':
      return 'string';
    case 'Vector':
      return type.types?.[0] ? `${formatCompactType(type.types[0])}[]` : 'unknown[]';
    case 'Map':
      if (type.types && type.types.length >= 2) {
        return `Map<${formatCompactType(type.types[0])}, ${formatCompactType(type.types[1])}>`;
      }
      return 'Map<unknown, unknown>';
    case 'Set':
      return type.types?.[0] ? `Set<${formatCompactType(type.types[0])}>` : 'Set<unknown>';
    case 'Option':
      return type.types?.[0] ? `${formatCompactType(type.types[0])} | null` : 'unknown | null';
    default:
      return type['type-name'] ?? 'unknown';
  }
}

/**
 * Format a circuit's signature: name(arg1: type1, arg2: type2)
 */
export function formatCircuitSignature(circuit: CircuitInfo): string {
  const args = circuit.arguments
    .map(a => `${a.name}: ${formatCompactType(a.type)}`)
    .join(', ');
  return `${circuit.name}(${args})`;
}

/**
 * Format a circuit's flags: "impure, proof" or "pure"
 */
export function formatCircuitFlags(circuit: CircuitInfo): string {
  if (circuit.pure) return 'pure';
  const flags: string[] = ['impure'];
  if (circuit.proof) flags.push('proof');
  return flags.join(', ');
}

/**
 * Format a witness's signature: name(arg1: type1) → returnType
 */
export function formatWitnessSignature(witness: WitnessInfo): string {
  const args = witness.arguments
    .map(a => `${a.name}: ${formatCompactType(a.type)}`)
    .join(', ');
  const returnType = formatCompactType(witness['result type']);
  const returnSuffix = returnType !== 'void' ? ` → ${returnType}` : '';
  return `${witness.name}(${args})${returnSuffix}`;
}

/**
 * Format contract info as structured JSON for --json output.
 */
export function toJsonOutput(info: ContractInfo): Record<string, unknown> {
  return {
    name: info.name,
    compilerVersion: info.compilerVersion,
    languageVersion: info.languageVersion,
    runtimeVersion: info.runtimeVersion,
    managedDir: info.managedDir,
    siblings: info.siblings,
    circuits: info.circuits.map(c => ({
      name: c.name,
      pure: c.pure,
      proof: c.proof,
      arguments: c.arguments.map(a => ({
        name: a.name,
        type: formatCompactType(a.type),
      })),
      returnType: formatCompactType(c['result-type']),
    })),
    witnesses: info.witnesses.map(w => ({
      name: w.name,
      arguments: w.arguments.map(a => ({
        name: a.name,
        type: formatCompactType(a.type),
      })),
      returnType: formatCompactType(w['result type']),
    })),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What is wrong with the list `key` of a contract-info.json, each entry checked by `entryProblems`. */
function listProblems(obj: Record<string, unknown>, key: string, entryProblems: (entry: unknown) => string[]): string[] {
  const list = obj[key];
  if (!Array.isArray(list)) return [list === undefined ? `"${key}" is missing` : `"${key}" is not a list`];
  return list.flatMap((entry, i) => entryProblems(entry).map((problem) => `${key}[${i}]${problem}`));
}

/** What an argument list lacks: a name and a type for each argument. */
function argumentProblems(args: unknown): string[] {
  if (!Array.isArray(args)) return [' has no "arguments" list'];
  return args.flatMap((arg, i) => isObject(arg) && typeof arg.name === 'string' && isObject(arg.type) && typeof arg.type['type-name'] === 'string'
    ? []
    : [` argument ${i} has no name and type`]);
}

function circuitProblems(entry: unknown): string[] {
  if (!isObject(entry) || typeof entry.name !== 'string') return [' has no "name"'];
  return [
    ...argumentProblems(entry.arguments),
    ...(isObject(entry['result-type']) ? [] : [' has no "result-type"']),
  ].map((problem) => ` (${entry.name})${problem}`);
}

function witnessProblems(entry: unknown): string[] {
  if (!isObject(entry) || typeof entry.name !== 'string') return [' has no "name"'];
  return [
    ...argumentProblems(entry.arguments),
    ...(isObject(entry['result type']) ? [] : [' has no "result type"']),
  ].map((problem) => ` (${entry.name})${problem}`);
}

/** A contract-info.json that is not what the Compact compiler writes: what is wrong with it. */
export class ContractInfoInvalidError extends Error {
  readonly code = 'CONTRACT_INFO_INVALID';
  constructor(readonly path: string, readonly problems: readonly string[]) {
    super(`${path} is not a contract-info.json the Compact compiler wrote: ${problems.join('; ')}. Compile the contract again (compact compile).`);
    this.name = 'ContractInfoInvalidError';
    Object.setPrototypeOf(this, ContractInfoInvalidError.prototype);
  }
}

/** No compiled contract (managed/<name>/compiler/contract-info.json) where one was looked for. */
export class ContractNotCompiledError extends Error {
  readonly code = 'CONTRACT_NOT_COMPILED';
  constructor(message: string) {
    super(message);
    this.name = 'ContractNotCompiledError';
    Object.setPrototypeOf(this, ContractNotCompiledError.prototype);
  }
}
