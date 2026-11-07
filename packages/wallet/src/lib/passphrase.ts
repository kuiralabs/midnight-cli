// mn's one passphrase: where it comes from, and the keystore's check that
// holds it to being one. It comes from MN_PASSPHRASE (scripts, the MCP
// server, CI; kept off the process list), else it is typed through the
// prompter its host gives (at a terminal, nothing echoed), else the command is refused before it changes anything.
// The check is a known value sealed under the passphrase in ~/.midnight: once
// it is there, every other passphrase is refused, so no secret is ever sealed
// under a second one.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureOwnerOnlyDir, FILE_MODE, throwIfCancelled, UsageError, isSealedSecret, openSecret, sealSecret, type Prompter, defineHostSlot, type Host, PASSPHRASE_ENV, WrongPassphraseError } from '@kuiralabs/midnight-cli-core';
import { getDefaultWalletPath, getWalletsDir } from './wallet-paths.ts';

/** The variable a non-interactive run sets the passphrase in (named in settings.ts). */
export { PASSPHRASE_ENV };

/** Where the keystore's check of the passphrase is kept, under the state root. */
const KEYSTORE_FILENAME = 'keystore.json';
/** The value the check seals: opening it proves the passphrase. */
const CHECK_VALUE = Buffer.from('mn keystore: the one passphrase', 'utf8');

/** No passphrase can be had: not in the environment, and no terminal to ask at. */
export class NoPassphraseError extends UsageError {
  readonly code = 'PASSPHRASE_REQUIRED';

  constructor() {
    super(`This needs mn's passphrase. Set ${PASSPHRASE_ENV}, or run it at a terminal to be asked for it.`);
    this.name = 'NoPassphraseError';
    Object.setPrototypeOf(this, NoPassphraseError.prototype);
  }
}

/** Where the passphrase is read from besides the prompter. */
export interface PassphraseSource {
  /** The environment to read MN_PASSPHRASE from: given, it stands in for the host's settings; readPassphrase reads none without it. */
  env?: Record<string, string | undefined>;
  /** Ask twice and refuse two that differ: for setting the passphrase. */
  confirm?: boolean;
  /** The call's cancellation: a call cancelled while the passphrase was asked for saves none. */
  signal?: AbortSignal;
}

const keystorePath = (root: string): string => path.join(root, KEYSTORE_FILENAME);

const ask = async (prompter: Prompter, question: string): Promise<string> => {
  const line = await prompter.askSecret(question);
  if (line === null) throw new NoPassphraseError();
  return line;
};

/** The passphrase: from MN_PASSPHRASE in `source.env`, else asked for through `prompter` (at the terminal) when it can ask. */
export async function readPassphrase(prompter: Prompter | null, source: PassphraseSource = {}): Promise<string> {
  const fromEnv = source.env?.[PASSPHRASE_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (prompter === null || !prompter.isInteractive()) throw new NoPassphraseError();
  const passphrase = await ask(prompter, source.confirm ? 'New passphrase for mn: ' : 'Passphrase for mn: ');
  if (source.confirm) {
    const again = await ask(prompter, 'Passphrase again: ');
    if (again !== passphrase) throw new UsageError('The two passphrases do not match.');
  }
  return passphrase;
}

/** True once mn's passphrase is set on this machine. */
export function isPassphraseSet(root: string): boolean {
  return fs.existsSync(keystorePath(root));
}

/** Sets mn's one passphrase. Refused when one is set already. */
export function establishPassphrase(root: string, passphrase: string): void {
  const file = keystorePath(root);
  if (fs.existsSync(file)) throw new UsageError(`mn's passphrase is already set (${file}).`);
  ensureOwnerOnlyDir(path.dirname(file));
  // `wx`: never over a check another process wrote meanwhile.
  fs.writeFileSync(file, JSON.stringify({ check: sealSecret(CHECK_VALUE, passphrase, 'keystore-check') }, null, 2) + '\n', { mode: FILE_MODE, flag: 'wx' });
}

/**
 * The sealed secret of one wallet under the state root `root`, or undefined
 * when no wallet there is sealed. Without the keystore it is what tells the
 * passphrase the wallets were sealed under from any other.
 */
function aSealedWalletSecret(root: string): unknown {
  const dir = getWalletsDir(root);
  const files = [
    ...(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f)) : []),
    getDefaultWalletPath(root),
  ];
  for (const file of files) {
    try {
      const sealed = (JSON.parse(fs.readFileSync(file, 'utf8')) as { sealed?: unknown }).sealed;
      if (isSealedSecret(sealed)) return sealed;
    } catch { /* missing or not a wallet file: not one to check against */ }
  }
  return undefined;
}

/**
 * Refuses, where the keystore is missing but wallets are sealed (it was
 * deleted, or never copied with them), a passphrase that doesn't open them:
 * set as the one passphrase, it would lock mn out of every one of them.
 */
function assertOpensSealedWallets(root: string, passphrase: string): void {
  const sealed = aSealedWalletSecret(root);
  if (sealed === undefined) return;
  try {
    openSecret(sealed, passphrase, 'wallet');
  } catch (error) {
    if (!(error instanceof WrongPassphraseError)) throw error;
    throw new WrongPassphraseError(
      `mn's keystore (${keystorePath(root)}) is missing, and the wallets in ${getWalletsDir(root)} are sealed under another passphrase.\n`
      + 'Give the passphrase they were sealed with: it restores the keystore. A different one is never set, so the wallets stay readable.',
    );
  }
}

/** Refuses `passphrase` unless it is the one set. */
export function checkPassphrase(root: string, passphrase: string): void {
  const { check } = JSON.parse(fs.readFileSync(keystorePath(root), 'utf8')) as { check: unknown };
  openSecret(check, passphrase, 'keystore-check');
}

/** The shortest passphrase mn accepts when one is set. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** What a passphrase is had through: the host's settings (MN_PASSPHRASE), its prompter, and its record of the passphrases it has unlocked. */
export type PassphraseHost = Pick<Host, 'settings' | 'prompter' | 'slot'>;

/** `source`, reading MN_PASSPHRASE from the host's settings unless it gives an environment of its own. */
const withHostPassphrase = (host: PassphraseHost, source: PassphraseSource): PassphraseSource =>
  source.env !== undefined ? source : { ...source, env: { [PASSPHRASE_ENV]: host.settings().passphrase } };

// The passphrase each host has unlocked, by state root: one prompt per run.
const UNLOCKED = defineHostSlot('passphrase.unlocked', () => new Map<string, string>());

/**
 * mn's passphrase, read and checked against the one set; asked for once per
 * run of `host`. One already checked is taken again only when the host's
 * settings (or `source.env`) name no other: a changed MN_PASSPHRASE is
 * checked afresh.
 */
export async function unlockPassphrase(host: PassphraseHost, root: string, source: PassphraseSource = {}): Promise<string> {
  const unlocked = host.slot(UNLOCKED);
  const known = unlocked.get(root);
  const read = withHostPassphrase(host, source);
  const fromEnv = read.env?.[PASSPHRASE_ENV];
  if (known !== undefined && (fromEnv === undefined || fromEnv === '' || fromEnv === known)) return known;
  if (!isPassphraseSet(root)) {
    if (aSealedWalletSecret(root) !== undefined) {
      throw new UsageError(`mn's keystore (${keystorePath(root)}) is missing, though wallets here are sealed. Restore it with: midnight wallet protect, giving the passphrase they were sealed with.`);
    }
    throw new UsageError('mn has no passphrase yet. Set one with: midnight wallet protect');
  }
  const passphrase = await readPassphrase(host.prompter, read);
  checkPassphrase(root, passphrase);
  unlocked.set(root, passphrase);
  return passphrase;
}

/**
 * The passphrase to seal a new secret under: the one set, or, on a machine
 * with none yet, a new one (asked twice at a terminal), which is then set.
 * Where wallets are sealed but the keystore is gone, only the passphrase
 * they were sealed under is set.
 */
export async function passphraseForNewSecret(host: PassphraseHost, root: string, source: PassphraseSource = {}): Promise<string> {
  if (isPassphraseSet(root)) return unlockPassphrase(host, root, source);
  const passphrase = await readPassphrase(host.prompter, { ...withHostPassphrase(host, source), confirm: true });
  assertOpensSealedWallets(root, passphrase);
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) {
    throw new UsageError(`mn's passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  throwIfCancelled(source.signal);
  establishPassphrase(root, passphrase);
  host.slot(UNLOCKED).set(root, passphrase);
  return passphrase;
}
