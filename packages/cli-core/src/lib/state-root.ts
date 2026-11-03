// Where mn keeps its state, as the host says: the shell's is ~/.midnight, a
// consumer's is its own. Each owner builds its paths under the root it is
// given (host.paths()); no library computes a path from the home directory
// itself. A host that gave no paths refuses instead of guessing.

export interface HostPaths {
  /** The state root: config, wallets, keystore, caches, localnet, accounts. */
  stateRoot: string;
  /** The user's home, for files of other tools that live there (Claude's config). */
  home: string;
}

export class NoStateRootError extends Error {
  readonly code = 'NO_STATE_ROOT';
  constructor() {
    super('No state root: the host gave mn no place to keep its state (createHost paths).');
    this.name = 'NoStateRootError';
    Object.setPrototypeOf(this, NoStateRootError.prototype);
  }
}
