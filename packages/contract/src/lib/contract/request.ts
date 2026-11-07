// A contract deploy or call, built from plain values and checked against the
// compiled contract before anything starts: the CLI checks it before the
// wallet syncs, the MCP server before it issues a confirmation token. The
// argument readers below build the same from a command's flags, with the
// working directory the caller gives as their default folder.

import { resolve } from 'node:path';
import { type ParsedArgs, getFlag, requireFlag, UsageError } from '@kuiralabs/midnight-cli-core';
import { findContractInfo, type ContractInfo } from './inspect.ts';
import { findWitnessFile, buildMissingWitnessError } from './witness-discovery.ts';
import { validateCallRequest, validateContractAddress } from './validate.ts';
import { LEGACY_SECRET_KEY } from './private-state-secret.ts';

export interface ContractDeployRequest {
  /** The dApp's root: the runner loads witnesses.js and keeps its level-db cache there. */
  dappDir: string;
  info: ContractInfo;
  constructorArgs: unknown[];
  /** --secret-key: seeds the contract's initial private state (32-byte hex) instead of the wallet's own secret. The script gets it through its environment. */
  privateStateSecretKey?: string;
}

export interface ContractCallRequest {
  dappDir: string;
  info: ContractInfo;
  address: string;
  circuit: string;
  callArgs: unknown[];
  /** --secret-key: the private-state secret the contract was deployed with, when not the wallet's own: 32-byte hex, or `legacy` (the default of an mn before 0.6.0). */
  privateStateSecretKey?: string;
}

/** Where a contract is: its dApp, and the compiled contract in it. */
export interface ContractLocation {
  /** The dApp's root, where witnesses.js and the runner's cache are. */
  dappDir: string;
  /** Where contract-info.json is looked for, when not in `dappDir`: a managed/<name>/ folder, or a folder above one. */
  managedDir?: string;
  /** Which of the dApp's compiled contracts, when it has more than one; the first by name when not given. */
  name?: string;
}

/**
 * A deploy of the compiled contract at `location`, its constructor given
 * `args` in order. Refuses a contract that declares witnesses without a
 * compiled witnesses.js in the dApp, and a `secretKey` that is not 32 bytes
 * of hex.
 */
export function contractDeployRequest(location: ContractLocation & { args?: unknown[]; secretKey?: string }): ContractDeployRequest {
  const { dappDir } = location;
  const { info } = findContractInfo(location.managedDir ?? dappDir, location.name);

  // A contract that declares witnesses needs its compiled witnesses.js: without
  // it the SDK fails mid-deploy, after a long wait, with "first (witnesses)
  // argument does not contain a function-valued field named X".
  const declaredWitnesses = info.witnesses.map((w) => w.name);
  if (declaredWitnesses.length > 0 && !findWitnessFile(dappDir)) {
    throw new Error(buildMissingWitnessError({ projectRoot: dappDir, witnessNames: declaredWitnesses }));
  }

  // For a contract whose constructor derives its owner from a witness
  // (owner = public_key(secret_key())); without it the secret is the wallet's own, from its seed.
  const privateStateSecretKey = location.secretKey;
  if (privateStateSecretKey === LEGACY_SECRET_KEY) {
    throw new UsageError(`--secret-key ${LEGACY_SECRET_KEY} is for calling a contract deployed by an mn before 0.6.0: it makes the wallet's public coin key the owner's secret, so a new contract must not be deployed with it`);
  }
  assertSecretKey(privateStateSecretKey, false);

  return { dappDir, info, constructorArgs: location.args ?? [], privateStateSecretKey };
}

/**
 * A call of `circuit` on the contract deployed at `address` (64 hex
 * characters), compiled at `location`, given `args` in order. Refuses a
 * circuit the contract can't call and a count of arguments it doesn't take.
 */
export function contractCallRequest(location: ContractLocation & { address: string; circuit: string; args?: unknown[]; secretKey?: string }): ContractCallRequest {
  const { dappDir, address, circuit } = location;
  const { info } = findContractInfo(location.managedDir ?? dappDir, location.name);
  const callArgs = location.args ?? [];
  validateContractAddress(address);
  validateCallRequest(info, circuit, callArgs);
  assertSecretKey(location.secretKey, true);
  return { dappDir, info, address, circuit, callArgs, ...(location.secretKey === undefined ? {} : { privateStateSecretKey: location.secretKey }) };
}

/** Refuses a --secret-key that is not 32 bytes of hex (or, where `legacyAllowed`, `legacy`). */
function assertSecretKey(secretKey: string | undefined, legacyAllowed: boolean): void {
  if (secretKey === undefined || /^[0-9a-fA-F]{64}$/.test(secretKey) || (legacyAllowed && secretKey === LEGACY_SECRET_KEY)) return;
  throw new UsageError(legacyAllowed
    ? `--secret-key must be 32 bytes of hex (64 chars), or "${LEGACY_SECRET_KEY}" for a contract deployed by an mn before 0.6.0 without one`
    : '--secret-key must be 32 bytes of hex (64 chars)');
}

/**
 * Where contract-info.json is looked for: --managed (a managed/<name>/ dir),
 * else --path (the dApp root), else `cwd`. --managed wins as the more
 * specific of the two.
 */
export function resolveScanDir(args: ParsedArgs, cwd: string): string {
  return resolve(cwd, getFlag(args, 'managed') ?? getFlag(args, 'path') ?? '.');
}

/** The dApp's root a command names: --path, else `cwd`. */
export function resolveDappDir(args: ParsedArgs, cwd: string): string {
  return resolve(cwd, getFlag(args, 'path') ?? '.');
}

/** --managed, read from `cwd`, when given. */
function managedDirOf(args: ParsedArgs, cwd: string): string | undefined {
  const managed = getFlag(args, 'managed');
  return managed === undefined ? undefined : resolve(cwd, managed);
}

/** `deploy [--args <json>] [--secret-key <hex>]` for the contract found from --managed/--path, else `cwd`. */
export function resolveContractDeployRequest(args: ParsedArgs, cwd: string): ContractDeployRequest {
  // --managed only says where contract-info.json lives; the runner still
  // needs the project root (--path or cwd) for witnesses.js.
  return contractDeployRequest({
    dappDir: resolveDappDir(args, cwd),
    managedDir: managedDirOf(args, cwd),
    name: getFlag(args, 'name'),
    args: parseArgsJson(getFlag(args, 'args')),
    secretKey: getFlag(args, 'secret-key'),
  });
}

/** `call --address <hex> --circuit <name> [--args <json>] [--secret-key <hex|legacy>]` for the contract found from --managed/--path, else `cwd`. */
export function resolveContractCallRequest(args: ParsedArgs, cwd: string): ContractCallRequest {
  const address = requireFlag(args, 'address', 'contract address');
  const circuit = requireFlag(args, 'circuit', 'circuit name');
  return contractCallRequest({
    dappDir: resolveDappDir(args, cwd),
    managedDir: managedDirOf(args, cwd),
    name: getFlag(args, 'name'),
    address,
    circuit,
    args: parseArgsJson(getFlag(args, 'args')),
    secretKey: getFlag(args, 'secret-key'),
  });
}

/** --args '<json>': an array is passed positionally, an object as its values in order. */
function parseArgsJson(argsJson: string | undefined): unknown[] {
  if (!argsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch (err) {
    throw new UsageError(`Invalid --args JSON: ${(err as Error).message}`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') return Object.values(parsed);
  throw new UsageError(`Invalid --args JSON: expected an array or an object, got ${JSON.stringify(parsed)}`);
}
