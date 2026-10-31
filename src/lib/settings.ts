// What the environment says, as settings libraries read. The environment
// variables are the shell's public contract (spec §5.4): the shell gives the
// libraries a source of settings, read from them as each is needed, and a
// consumer gives its own. A library never reads the environment itself; with
// no source, every setting is unset.

export interface Settings {
  /** MN_PASSPHRASE: mn's passphrase, for a run with no terminal to ask at. */
  passphrase: string | undefined;
  /** MN_SEED: a seed for the commands that take --seed. */
  seed: string | undefined;
  /** MN_NO_LOCAL_DETECT=1: don't look for a local stack in Docker. */
  isLocalDetectOff: boolean;
  /** MN_DUST_SYNC_BIN: the native Dust sync sidecar to run. */
  dustSyncBin: string | undefined;
  /** MN_DISABLE_NATIVE_DUST=1: sync Dust in-process, without the sidecar. */
  isNativeDustOff: boolean;
  /** MN_DISABLE_DUST_COLLAPSE=1: keep the full Dust generation tree. */
  isDustCollapseOff: boolean;
  /** MN_BLOCKFROST_PROJECT_ID, then BLOCKFROST_PROJECT_ID: a Blockfrost project id. */
  blockfrostProjectId: string | undefined;
  sharedBlockfrostProjectId: string | undefined;
}

/** The settings the variables of §5.4 in `env` give. */
export function settingsFromEnvironment(env: Record<string, string | undefined>): Settings {
  return {
    passphrase: env.MN_PASSPHRASE,
    seed: env.MN_SEED,
    isLocalDetectOff: env.MN_NO_LOCAL_DETECT === '1',
    dustSyncBin: env.MN_DUST_SYNC_BIN,
    isNativeDustOff: env.MN_DISABLE_NATIVE_DUST === '1',
    isDustCollapseOff: env.MN_DISABLE_DUST_COLLAPSE === '1',
    blockfrostProjectId: env.MN_BLOCKFROST_PROJECT_ID,
    sharedBlockfrostProjectId: env.BLOCKFROST_PROJECT_ID,
  };
}

/** Every setting unset: what a library sees with no source. */
const UNSET: Settings = settingsFromEnvironment({});

let source: (() => Settings) | null = null;

/** Where settings come from from now on; null for none. */
export function setSettingsSource(next: (() => Settings) | null): void {
  source = next;
}

/** The settings now. */
export function settings(): Settings {
  return source?.() ?? UNSET;
}
