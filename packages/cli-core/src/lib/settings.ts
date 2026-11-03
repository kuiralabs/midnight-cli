// What the environment says, as settings libraries read. The environment
// variables are the shell's public contract: the shell's host reads its
// settings from them as each is needed, and a consumer's host gives its own.
// A library never reads the environment itself: it takes the settings from
// its call's host, or as a parameter.

/** The environment variables that become settings: their names, in one place. */
export const PASSPHRASE_ENV = 'MN_PASSPHRASE';
export const SEED_ENV = 'MN_SEED';
export const NO_LOCAL_DETECT_ENV = 'MN_NO_LOCAL_DETECT';
export const DUST_SYNC_BIN_ENV = 'MN_DUST_SYNC_BIN';
export const DISABLE_NATIVE_DUST_ENV = 'MN_DISABLE_NATIVE_DUST';
export const DUST_COLLAPSE_DISABLE_ENV = 'MN_DISABLE_DUST_COLLAPSE';
export const BLOCKFROST_PROJECT_ID_ENV = 'MN_BLOCKFROST_PROJECT_ID';
/** The name Midnight's own docs give the Blockfrost variable; other tools use it too. */
export const SHARED_BLOCKFROST_PROJECT_ID_ENV = 'BLOCKFROST_PROJECT_ID';

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

/** The settings the environment variables in `env` give. */
export function settingsFromEnvironment(env: Record<string, string | undefined>): Settings {
  return {
    passphrase: env[PASSPHRASE_ENV],
    seed: env[SEED_ENV],
    isLocalDetectOff: env[NO_LOCAL_DETECT_ENV] === '1',
    dustSyncBin: env[DUST_SYNC_BIN_ENV],
    isNativeDustOff: env[DISABLE_NATIVE_DUST_ENV] === '1',
    isDustCollapseOff: env[DUST_COLLAPSE_DISABLE_ENV] === '1',
    blockfrostProjectId: env[BLOCKFROST_PROJECT_ID_ENV],
    sharedBlockfrostProjectId: env[SHARED_BLOCKFROST_PROJECT_ID_ENV],
  };
}
