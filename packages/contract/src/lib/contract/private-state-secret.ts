// Resolves the 32-byte secret seeded into a contract's initial private state.
// Shared between the bridge runner (where it executes via `.toString()`-inlining
// into the generated deploy/call script) and the test suite (where it's called
// directly) — one source, so every branch is unit-tested without a child process.
//
// Written in plain ES2017+ JS-friendly TS so its `toString()` form is portable
// across Node versions (same constraint as arg-coerce.ts).

/**
 * The value of `--secret-key` that asks for the secret mn used by default
 * before 0.6.0: the wallet's shielded coin public key. That key is public (it
 * is part of the shielded address), so it is only for calling a contract
 * deployed with that default.
 */
export const LEGACY_SECRET_KEY = 'legacy';

/**
 * The private-state secret the script was given (env MN_PRIVATE_STATE_SECRET):
 *   - 64 hex characters: that secret (mn's default, derived from the wallet's
 *     seed, or the caller's `--secret-key`);
 *   - `legacy`: the wallet's coin public key, the default of an mn before
 *     0.6.0, for a contract deployed with it.
 * Anything else is refused: the script never makes a secret up.
 */
export function resolvePrivateStateSecretKey(
  given: string | undefined,
  walletCoinPublicKey: string | undefined,
): Uint8Array {
  // No inner named functions: a bundler's keepNames would wrap them in a
  // helper the generated script doesn't have.
  const source = given === 'legacy' ? walletCoinPublicKey : (given !== undefined && given.length === 64 ? given : undefined);
  const chosen = typeof source === 'string' && /^[0-9a-fA-F]{64}/.test(source) ? source.slice(0, 64) : undefined;
  if (chosen === undefined) {
    throw new Error(given === 'legacy'
      ? 'The served wallet gave no coin public key to use as the legacy private-state secret.'
      : 'No private-state secret was given to the contract script: it needs 64 hex characters, or "legacy".');
  }
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = parseInt(chosen.substr(i * 2, 2), 16);
  return key;
}
