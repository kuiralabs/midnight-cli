// Opens a dApp's contract private-state store (the LevelDB folder midnight-js's
// level provider keeps) for one wallet, before the provider touches it. Shared
// between the generated deploy/call script (inlined with `.toString()`, so it
// imports nothing: what it uses comes in `deps`) and the test suite.
//
// The store holds the contract's private state and its signing keys, so it is
// kept to its owner: the folder 0700 and its files 0600 (an older store is
// tightened), and every entry encrypted with the wallet's own password (from
// its seed, see contract-keys.ts in cli-core). An mn before 0.6.0 encrypted
// every wallet's entries with one fixed password under one shared account;
// the first wallet to open such a store takes those entries over, re-encrypted
// with its own password, once. A record in the folder says which wallet did
// and which of the store's parts are done.

/** What the store is opened with: the filesystem calls it makes, and the level provider. */
export interface PrivateStateStoreDeps {
  fs: {
    existsSync(path: string): boolean;
    mkdirSync(path: string, options: { recursive: boolean; mode: number }): unknown;
    chmodSync(path: string, mode: number): void;
    readdirSync(path: string): string[];
    statSync(path: string): { isDirectory(): boolean };
    readFileSync(path: string, encoding: 'utf8'): string;
    writeFileSync(path: string, data: string, options: { mode: number }): void;
  };
  join(...parts: string[]): string;
  /** A function that returns `value`: what the provider takes a password as. */
  provide(value: string): () => string;
  /** Sets the process's file-creation mask; returns the one before. */
  umask(mask: number): number;
  /** midnight-js's levelPrivateStateProvider. */
  levelPrivateStateProvider(config: Record<string, unknown>): {
    changePassword(oldPassword: () => string, newPassword: () => string): Promise<unknown>;
    changeSigningKeysPassword(oldPassword: () => string, newPassword: () => string): Promise<unknown>;
  };
}

export interface PrivateStateStoreOptions {
  /** The store's folder (absolute): `midnight-level-db` in the folder the script runs in. */
  dir: string;
  /** The private-state store name the script uses (one per contract name). */
  storeName: string;
  /** The wallet's storage password. */
  password: string | undefined;
  /** The wallet's own account in the store. */
  accountId: string | undefined;
}

/**
 * Makes the store's folder (0700) or tightens an existing one, takes over the
 * entries an mn before 0.6.0 wrote when this wallet is the first to open it,
 * and returns the account this wallet's entries are kept under: the old shared
 * account for the wallet that took it over, its own account otherwise.
 */
export async function openPrivateStateStore(deps: PrivateStateStoreDeps, options: PrivateStateStoreOptions): Promise<{ accountId: string }> {
  const LEGACY_PASSWORD = 'mn-contract-default-pwd-16ch';
  const LEGACY_ACCOUNT = 'mn-contract-runner';
  const SIGNING_KEYS = '(signing keys)';
  const RECORD = 'mn-private-state.json';
  const { fs, join } = deps;
  const { dir, storeName, password, accountId } = options;
  if (typeof password !== 'string' || password.length === 0 || typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('The contract script was given no private-state password or account (MN_PRIVATE_STATE_PASSWORD, MN_PRIVATE_STATE_ACCOUNT): it is started by mn contract deploy or call, which derive them from the paying wallet.');
  }

  // Everything LevelDB writes from here on is the owner's only.
  deps.umask(0o077);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) {
      const path = join(dir, name);
      fs.chmodSync(path, fs.statSync(path).isDirectory() ? 0o700 : 0o600);
    }
  }

  const recordPath = join(dir, RECORD);
  let record: { version: number; legacyOwner: string | null; rotated: string[] };
  if (fs.existsSync(recordPath)) {
    try {
      record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    } catch (err) {
      throw new Error(`The private-state store's record ${recordPath} could not be read (${(err as Error).message}). Restore it, or move the ${dir} folder away to start a new store (its contracts' private state and signing keys stay in the moved folder).`);
    }
    if (record === null || typeof record !== 'object' || !Array.isArray(record.rotated)) {
      throw new Error(`The private-state store's record ${recordPath} is not one mn wrote. Restore it, or move the ${dir} folder away to start a new store.`);
    }
  } else {
    // A store with data and no record was written by an mn before 0.6.0: this wallet takes it over.
    record = { version: 1, legacyOwner: fs.existsSync(join(dir, 'CURRENT')) ? accountId : null, rotated: [] };
  }
  // Written inline, never through an inner function: a bundler's keepNames
  // would wrap one in a helper the generated script doesn't have.
  if (record.legacyOwner !== accountId) {
    if (!fs.existsSync(recordPath)) fs.writeFileSync(recordPath, JSON.stringify(record) + '\n', { mode: 0o600 });
    return { accountId };
  }

  const legacy = deps.levelPrivateStateProvider({
    midnightDbName: dir,
    privateStateStoreName: storeName,
    accountId: LEGACY_ACCOUNT,
    // Through deps.provide, not an arrow here: a bundler's keepNames would name one set as a property.
    privateStoragePasswordProvider: deps.provide(LEGACY_PASSWORD),
  });
  const parts: Array<[string, 'changePassword' | 'changeSigningKeysPassword']> = [[storeName, 'changePassword'], [SIGNING_KEYS, 'changeSigningKeysPassword']];
  for (const [part, rotate] of parts) {
    if (record.rotated.includes(part)) continue;
    try {
      await legacy[rotate](deps.provide(LEGACY_PASSWORD), deps.provide(password));
    } catch (err) {
      // Already under the wallet's password: a run that rotated it stopped before it could say so.
      if (!String((err as Error)?.message ?? '').includes('Old password is incorrect')) throw err;
    }
    record.rotated.push(part);
    fs.writeFileSync(recordPath, JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  if (!fs.existsSync(recordPath)) fs.writeFileSync(recordPath, JSON.stringify(record) + '\n', { mode: 0o600 });
  return { accountId: LEGACY_ACCOUNT };
}
