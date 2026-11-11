// The private state a contract call starts from: the one the contract's store
// holds, which the last call's witnesses left; seeded (with the wallet's
// secret, or --secret-key) only when the store holds none, as on the first
// call after a deploy made on another machine.
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

/**
 * The private-state options of the call's findDeployedContract:
 * `{ initialPrivateState }` from `seed` when `states` hold nothing under
 * `privateStateId`, else none, so the find starts the call from the stored
 * state.
 */
export async function callPrivateStateOptions(states: ContractPrivateStates, privateStateId: string, seed: () => unknown): Promise<{ initialPrivateState?: unknown }> {
  const stored = await states.get(privateStateId);
  return stored === null || stored === undefined ? { initialPrivateState: seed() } : {};
}
