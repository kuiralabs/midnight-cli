// An argument a circuit or a constructor refused while a contract script ran
// it: the wrong type ("abc" or 1.5 for a Uint, a Uint over its range), or a
// wrong count. The compiled contract's own checks throw a CompactError whose
// words count the context midnight-js passes first: "increment argument 1
// (argument 2 as invoked from Typescript)", "expected 2 arguments (as invoked
// from Typescript), received 1" for one argument given. The script reports it
// with INVALID_ARGS in words that count only the arguments given
// (SCRIPT_PRELUDE), and the runner names the contract, the circuit and the
// argument (namingInvalidArgument). Nothing was proven, sent or paid.

import { UsageError } from '@kuiralabs/midnight-cli-core';

/**
 * The refused argument in words that count only the arguments the user gave,
 * or undefined when the failure is no such refusal: "argument 1 of increment:
 * expected a value of type Uint<0..65535> (vault.compact line 21 char 1)", or
 * "tag takes 3 arguments, 1 given". The value given is left out (a circuit's
 * arguments stay private). Only compact-runtime's own error counts, found on
 * the failure, its causes or the errors it lists. Serialized into the
 * generated script (.toString()), so it refers to nothing outside itself.
 */
export function invalidArgumentOf(failure: unknown): string | undefined {
  const TYPE = /^type error: (.+?) argument (\d+) \(argument \d+ as invoked from Typescript\) at (.+?); expected value of type (.+?) but received /;
  const COUNT = /^(.+?): expected (\d+) arguments? \(as invoked from Typescript\), received (\d+)$/;
  const seen = new Set<unknown>();
  const pending: unknown[] = [failure];
  while (pending.length > 0) {
    const at = pending.shift();
    if (typeof at !== 'object' || at === null || seen.has(at)) continue;
    seen.add(at);
    const { isCompactError, message, cause, errors } = at as { isCompactError?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (isCompactError === true && typeof message === 'string') {
      const type = TYPE.exec(message);
      if (type) return `argument ${type[2]} of ${type[1]}: expected a value of type ${type[4]} (${type[3]})`;
      const count = COUNT.exec(message);
      if (count) {
        const takes = Number(count[2]) - 1;
        return `${count[1]} takes ${takes} argument${takes === 1 ? '' : 's'}, ${Number(count[3]) - 1} given`;
      }
    }
    pending.push(cause);
    if (Array.isArray(errors)) pending.push(...errors);
  }
  return undefined;
}

/** A circuit's or constructor's argument the contract refused: INVALID_ARGS, naming the argument once. */
export class ContractArgumentError extends UsageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message);
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    this.name = 'ContractArgumentError';
    Object.setPrototypeOf(this, ContractArgumentError.prototype);
  }
}

/** What the runner knows of the contract to name an argument: its name, and its circuits' argument names. */
export interface ArgumentNames {
  readonly name: string;
  readonly circuits: readonly { readonly name: string; readonly arguments: readonly { readonly name: string }[] }[];
}

const REFUSED_TYPE = /^argument (\d+) of .+?: expected a value of type (.+)$/;
const REFUSED_COUNT = /^.+? takes (\d+) arguments?, (\d+) given$/;

/**
 * A script's report of a refused argument (INVALID_ARGS, in invalidArgumentOf's
 * words) as a ContractArgumentError naming the contract, the circuit
 * (undefined: the constructor) and the argument by its position and name;
 * `constructorParameters` are the constructor's names. Any other failure as it is.
 */
export function namingInvalidArgument(err: unknown, contract: ArgumentNames, circuit: string | undefined, constructorParameters: readonly string[]): unknown {
  if (!(err instanceof Error) || (err as { code?: unknown }).code !== 'INVALID_ARGS') return err;
  const names = circuit === undefined ? constructorParameters : (contract.circuits.find((c) => c.name === circuit)?.arguments.map((a) => a.name) ?? []);
  const where = circuit === undefined ? `${contract.name}'s constructor` : `${contract.name}'s circuit ${circuit}`;
  const type = REFUSED_TYPE.exec(err.message);
  if (type) {
    const position = Number(type[1]);
    const name = names[position - 1];
    return new ContractArgumentError(
      `${where} refused argument ${position}${name === undefined ? '' : ` (${name})`}: it is not a value of type ${type[2]}. Nothing was sent or paid.`,
      { cause: err },
    );
  }
  const count = REFUSED_COUNT.exec(err.message);
  if (count) {
    const takes = Number(count[1]);
    const given = Number(count[2]);
    const listed = names.length === takes && takes > 0 ? ` (${names.join(', ')})` : '';
    return new ContractArgumentError(`${where} takes ${takes} argument${takes === 1 ? '' : 's'}${listed}; ${given} ${given === 1 ? 'was' : 'were'} given.`, { cause: err });
  }
  return err;
}
