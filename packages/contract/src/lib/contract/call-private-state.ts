// The private state a contract call starts from: the one the contract's store
// holds, which the last call's witnesses left; seeded (with the wallet's
// secret, or --secret-key) only when the store holds none, as on the first
// call after a deploy made on another machine. A --secret-key given for a
// store that already holds a private state seeds nothing; the call says so
// when that state doesn't hold the same secret.
//
// midnight-js's findDeployedContract stores the `initialPrivateState` it is
// given over whatever the store holds, and the call's circuit then reads the
// store: so a call that always passed one started every time from the seeded
// state, and what a witness saved was lost by the next call. A call now passes
// one only when the store holds nothing (without one, the find reports the
// stored state). The call holds the contract's call lock for its whole run,
// so nothing writes the store between this read and the find.
//
// Serialized into the generated call script (runner.ts), so it imports
// nothing and uses no name of this module.

/** The private state of one contract in its store, as midnight-js's level provider gives it (forContract). */
export interface ContractPrivateStates {
  get(privateStateId: string): Promise<unknown>;
}

/** The `--secret-key` the call was given, and what to do when the store already holds a private state it isn't in. */
export interface GivenPrivateStateSecret {
  /** The secret's 32 bytes, as the script resolved them (resolvePrivateStateSecretKey). */
  secret: Uint8Array;
  /** Called when the store's private state holds nothing equal to `secret`: the call runs from the stored state, not from the given secret. */
  unused: () => void;
}

/**
 * The private-state options of the call's findDeployedContract:
 * `{ initialPrivateState }` from `seed` when `states` hold nothing under
 * `privateStateId`, else none, so the find starts the call from the stored
 * state.
 *
 * With `given` (the caller's --secret-key) and a stored state, the secret
 * seeds nothing: `given.unused` is called unless the stored state holds the
 * same 32 bytes somewhere (a byte array, an array of numbers, or 64 hex
 * characters), as a state seeded with that secret does. The state's shape is
 * the contract's own (its witnesses' createPrivateState), so this is a search,
 * not a field read. Neither secret is written anywhere.
 */
export async function callPrivateStateOptions(states: ContractPrivateStates, privateStateId: string, seed: () => unknown, given?: GivenPrivateStateSecret): Promise<{ initialPrivateState?: unknown }> {
  const stored = await states.get(privateStateId);
  if (stored === null || stored === undefined) return { initialPrivateState: seed() };
  if (given !== undefined) {
    // No inner named functions (a bundler's keepNames would wrap them in a
    // helper the generated script doesn't have): a walk with a stack.
    const want = given.secret;
    let wantHex = '';
    for (let i = 0; i < want.length; i++) wantHex += (want[i]! < 16 ? '0' : '') + want[i]!.toString(16);
    let found = false;
    const pending: unknown[] = [stored];
    const seen = new Set<unknown>();
    while (!found && pending.length > 0) {
      const value = pending.pop();
      if (typeof value === 'string') {
        found = value.length === wantHex.length && value.toLowerCase() === wantHex;
        continue;
      }
      if (value === null || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      const items: ArrayLike<unknown> | undefined = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : (Array.isArray(value) ? value : undefined);
      if (items !== undefined && items.length === want.length) {
        let same = true;
        for (let i = 0; i < want.length && same; i++) same = items[i] === want[i];
        if (same) { found = true; continue; }
      }
      if (ArrayBuffer.isView(value)) continue;
      for (const child of value instanceof Map ? value.values() : Object.values(value)) pending.push(child);
    }
    if (!found) given.unused();
  }
  return {};
}
