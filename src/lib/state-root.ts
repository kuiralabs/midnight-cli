// Where mn keeps its state, as the host says: the shell's is ~/.midnight, a
// consumer's is its own (spec §7). Each owner builds its paths under this
// root; no library computes a path from the home directory itself. The source
// is read as each path is built, so a host that changes HOME mid-run (the test
// run does) is followed. With no source, a library refuses instead of guessing.

export interface HostPaths {
  /** The state root: config, wallets, keystore, caches, localnet, accounts. */
  stateRoot: string;
  /** The user's home, for files of other tools that live there (Claude's config). */
  home: string;
}

export class NoStateRootError extends Error {
  readonly code = 'NO_STATE_ROOT';
  constructor() {
    super('No state root: the host gave mn no place to keep its state (setHostPathsSource).');
    this.name = 'NoStateRootError';
    Object.setPrototypeOf(this, NoStateRootError.prototype);
  }
}

let source: (() => HostPaths) | null = null;

/** Where the host's paths come from from now on; null for none. */
export function setHostPathsSource(next: (() => HostPaths) | null): void {
  source = next;
}

function hostPaths(): HostPaths {
  if (source === null) throw new NoStateRootError();
  return source();
}

/** The state root the host gave. */
export function stateRoot(): string {
  return hostPaths().stateRoot;
}

/** The user's home the host gave. */
export function userHome(): string {
  return hostPaths().home;
}
