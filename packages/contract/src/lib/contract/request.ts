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
import { ARGS_FROM_STDIN, type ArgsSource, readGivenArgs, type StdinReader } from './args-input.ts';
import { type GivenSecretKey, readGivenSecretKey, SECRET_KEY_FROM_STDIN, type SecretKeySource } from './secret-key-input.ts';
import { expandCoinShorthands, type FreshCoin } from './coin-shorthand.ts';
import { privateArgumentsOf } from './private-arguments.ts';

export interface ContractDeployRequest {
  /** The dApp's root: the runner loads witnesses.js and keeps its level-db cache there. */
  dappDir: string;
  info: ContractInfo;
  constructorArgs: unknown[];
  /** Where the arguments were given (--args, --args-file, --args -); absent from a request built from values. */
  argsSource?: ArgsSource;
  /** --secret-key: seeds the contract's initial private state (32-byte hex) instead of the wallet's own secret. The script gets it through its environment. */
  privateStateSecretKey?: string;
  /** Where the secret was given (--secret-key, --secret-key-file, --secret-key -); absent from a request built from values. */
  secretKeySource?: SecretKeySource;
}

export interface ContractCallRequest {
  dappDir: string;
  info: ContractInfo;
  address: string;
  circuit: string;
  /** The circuit's arguments, every fresh-coin shorthand expanded (coin-shorthand.ts). */
  callArgs: unknown[];
  /** The fresh coins mn made for `{"@coin": ...}` arguments, in order: where each is and its nonce. */
  freshCoins: FreshCoin[];
  /** Where the arguments were given (--args, --args-file, --args -); absent from a request built from values. */
  argsSource?: ArgsSource;
  /** The circuit's arguments its proof keeps private, as its ZK IR shows them; undefined when mn can't tell (privateArgumentsOf). */
  privateArguments?: string[];
  /** --secret-key: the private-state secret the contract was deployed with, when not the wallet's own: 32-byte hex, or `legacy` (the default of an mn before 0.6.0). */
  privateStateSecretKey?: string;
  /** Where the secret was given (--secret-key, --secret-key-file, --secret-key -); absent from a request built from values. */
  secretKeySource?: SecretKeySource;
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

  // A constructor's argument types aren't in contract-info.json: a fresh-coin shorthand is refused there.
  const { args: constructorArgs } = expandCoinShorthands(location.args ?? [], undefined);
  return { dappDir, info, constructorArgs, privateStateSecretKey };
}

/**
 * A call of `circuit` on the contract deployed at `address` (64 hex
 * characters), compiled at `location`, given `args` in order. Refuses a
 * circuit the contract can't call and a count of arguments it doesn't take.
 */
export function contractCallRequest(location: ContractLocation & { address: string; circuit: string; args?: unknown[]; secretKey?: string }): ContractCallRequest {
  const { dappDir, address, circuit } = location;
  const { info } = findContractInfo(location.managedDir ?? dappDir, location.name);
  const given = location.args ?? [];
  validateContractAddress(address);
  validateCallRequest(info, circuit, given);
  assertSecretKey(location.secretKey, true);
  const called = info.circuits.find((c) => c.name === circuit)!;
  const { args: callArgs, freshCoins } = expandCoinShorthands(given, called.arguments);
  const privateArguments = called.arguments.length === 0 ? [] : privateArgumentsOf(info.managedDir, called);
  return {
    dappDir, info, address, circuit, callArgs, freshCoins,
    ...(privateArguments === undefined ? {} : { privateArguments }),
    ...(location.secretKey === undefined ? {} : { privateStateSecretKey: location.secretKey }),
  };
}

/** Refuses a --secret-key that is not 32 bytes of hex (or, where `legacyAllowed`, `legacy`). */
function assertSecretKey(secretKey: string | undefined, legacyAllowed: boolean): void {
  if (secretKey === undefined || /^[0-9a-fA-F]{64}$/.test(secretKey) || (legacyAllowed && secretKey === LEGACY_SECRET_KEY)) return;
  throw new UsageError(legacyAllowed
    ? `The private-state secret (--secret-key, --secret-key-file) must be 32 bytes of hex (64 chars), or "${LEGACY_SECRET_KEY}" for a contract deployed by an mn before 0.6.0 without one`
    : 'The private-state secret (--secret-key, --secret-key-file) must be 32 bytes of hex (64 chars)');
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

/**
 * The arguments a command's --args or --args-file give (args-input.ts) and
 * the secret its --secret-key or --secret-key-file give (secret-key-input.ts),
 * `-` read with `readStdin`: the standard input is read once, so only one of
 * them can take it.
 */
function givenInputsOf(args: ParsedArgs, cwd: string, readStdin: StdinReader | undefined): { given: ReturnType<typeof readGivenArgs>; secret: GivenSecretKey } {
  if (getFlag(args, 'args') === ARGS_FROM_STDIN && getFlag(args, 'secret-key') === SECRET_KEY_FROM_STDIN) {
    throw new UsageError('--args - and --secret-key - both read the standard input, which has one: give one of them from a file (--args-file or --secret-key-file).');
  }
  return {
    given: readGivenArgs({ args: getFlag(args, 'args'), argsFile: getFlag(args, 'args-file') }, cwd, readStdin),
    secret: readGivenSecretKey({ secretKey: getFlag(args, 'secret-key'), secretKeyFile: getFlag(args, 'secret-key-file') }, cwd, readStdin),
  };
}

/**
 * `deploy [--args <json>|-] [--args-file <path>] [--secret-key <hex>|-] [--secret-key-file <path>]` for the
 * contract found from --managed/--path, else `cwd`; `--args -` reads the
 * standard input with `readStdin`, and is refused without one.
 */
export function resolveContractDeployRequest(args: ParsedArgs, cwd: string, readStdin?: StdinReader): ContractDeployRequest {
  const { given, secret } = givenInputsOf(args, cwd, readStdin);
  // --managed only says where contract-info.json lives; the runner still
  // needs the project root (--path or cwd) for witnesses.js.
  return {
    ...contractDeployRequest({
      dappDir: resolveDappDir(args, cwd),
      managedDir: managedDirOf(args, cwd),
      name: getFlag(args, 'name'),
      args: given.args,
      secretKey: secret.secretKey,
    }),
    argsSource: given.source,
    secretKeySource: secret.source,
  };
}

/**
 * `call --address <hex> --circuit <name> [--args <json>|-] [--args-file <path>]
 * [--secret-key <hex|legacy|->] [--secret-key-file <path>]` for the contract found from --managed/--path,
 * else `cwd`; `--args -` reads the standard input with `readStdin`, and is
 * refused without one.
 */
export function resolveContractCallRequest(args: ParsedArgs, cwd: string, readStdin?: StdinReader): ContractCallRequest {
  const address = requireFlag(args, 'address', 'contract address');
  const circuit = requireFlag(args, 'circuit', 'circuit name');
  const { given, secret } = givenInputsOf(args, cwd, readStdin);
  return {
    ...contractCallRequest({
      dappDir: resolveDappDir(args, cwd),
      managedDir: managedDirOf(args, cwd),
      name: getFlag(args, 'name'),
      address,
      circuit,
      args: given.args,
      secretKey: secret.secretKey,
    }),
    argsSource: given.source,
    secretKeySource: secret.source,
  };
}
