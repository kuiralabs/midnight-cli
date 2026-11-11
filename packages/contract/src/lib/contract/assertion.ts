// A Compact `assert` that failed while a contract script ran a circuit or the
// constructor. midnight-js runs the contract on this machine first, to build
// the transaction it then proves, balances and submits; an assert that fails
// stops it there, so nothing was proven, sent or paid. The script reports it
// with CONTRACT_ASSERTION_FAILED and the assert's own text (SCRIPT_PRELUDE),
// and the runner names the contract and the circuit (namingFailedAssertion).

/** The code a script reports a failed assert with, and the code of ContractAssertionError. */
export const CONTRACT_ASSERTION_FAILED = 'CONTRACT_ASSERTION_FAILED';

/**
 * The text of the Compact assert a failure comes from, or undefined when it
 * comes from none. compact-runtime throws a CompactError (`isCompactError`)
 * saying `failed assert: <text>`; midnight-js hangs it on the `cause` of its
 * own error, or lists it in `errors`. Serialized into the generated script
 * (.toString()), so it refers to nothing outside itself.
 */
export function failedAssertionOf(failure: unknown): string | undefined {
  const prefix = 'failed assert: ';
  const seen = new Set<unknown>();
  const pending: unknown[] = [failure];
  while (pending.length > 0) {
    const at = pending.shift();
    if (typeof at !== 'object' || at === null || seen.has(at)) continue;
    seen.add(at);
    const { isCompactError, message, cause, errors } = at as { isCompactError?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (isCompactError === true && typeof message === 'string' && message.startsWith(prefix)) return message.slice(prefix.length);
    pending.push(cause);
    if (Array.isArray(errors)) pending.push(...errors);
  }
  return undefined;
}

/** A contract's assert failed while its circuit or constructor ran on this machine: nothing was sent or paid. */
export class ContractAssertionError extends Error {
  readonly code = 'CONTRACT_ASSERTION_FAILED';
  /** The contract's name. */
  readonly contract: string;
  /** The circuit whose assert failed; undefined for the constructor. */
  readonly circuit: string | undefined;
  /** The assert's own text, as the contract wrote it. */
  readonly assertion: string;

  /** `circuit` undefined: the constructor a deploy runs. */
  constructor(contract: string, circuit: string | undefined, assertion: string, options?: ErrorOptions) {
    const where = circuit === undefined ? `${contract}'s constructor` : `${contract}'s circuit ${circuit}`;
    const what = circuit === undefined ? 'deploy' : 'call';
    super(
      `${where} refused the ${what}: assert failed: "${assertion}".\n` +
      `Nothing was sent or paid: the contract runs on this machine before its transaction is proven or submitted, and it stopped there.`,
      options,
    );
    this.name = 'ContractAssertionError';
    this.contract = contract;
    this.circuit = circuit;
    this.assertion = assertion;
    Object.setPrototypeOf(this, ContractAssertionError.prototype);
  }
}

/** A script's report of a failed assert, as ContractAssertionError naming the contract and the circuit (undefined: the constructor); any other failure as it is. */
export function namingFailedAssertion(err: unknown, contract: string, circuit: string | undefined): unknown {
  return (err as { code?: unknown } | null)?.code === CONTRACT_ASSERTION_FAILED && err instanceof Error
    ? new ContractAssertionError(contract, circuit, err.message, { cause: err })
    : err;
}
