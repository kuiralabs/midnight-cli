// mn's one passphrase: where it comes from, and the keystore's check that
// holds it to being one. It comes from MN_PASSPHRASE (scripts, the MCP
// server, CI; kept off the process list), else it is typed through the
// prompter (at a terminal, nothing echoed), else the command is refused before it changes anything.
// The check is a known value sealed under the passphrase in ~/.midnight: once
// it is there, every other passphrase is refused, so no secret is ever sealed
// under a second one.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DIR_MODE, FILE_MODE } from './constants.ts';
import { UsageError } from './errors.ts';
import { openSecret, sealSecret } from './keystore.ts';
import { currentPrompter, type Prompter } from './prompter.ts';
import { settings } from './settings.ts';
import { stateRoot } from './state-root.ts';

/** The variable a non-interactive run sets the passphrase in. */
export const PASSPHRASE_ENV = 'MN_PASSPHRASE';

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

/** Where the passphrase is read from: the environment, and a prompter (the one set, unless given) if it can ask. */
export interface PassphraseSource {
  env?: Record<string, string | undefined>;
  prompter?: Prompter | null;
  /** Ask twice and refuse two that differ: for setting the passphrase. */
  confirm?: boolean;
}

const keystorePath = (root: string): string => path.join(root, KEYSTORE_FILENAME);

const ask = async (prompter: Prompter, question: string): Promise<string> => {
  const line = await prompter.askSecret(question);
  if (line === null) throw new NoPassphraseError();
  return line;
};

/** The passphrase: from MN_PASSPHRASE, else asked for at the terminal. */
export async function readPassphrase(source: PassphraseSource = {}): Promise<string> {
  const fromEnv = source.env !== undefined ? source.env[PASSPHRASE_ENV] : settings().passphrase;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const prompter = source.prompter === undefined ? currentPrompter() : source.prompter;
  if (prompter === null || !prompter.isInteractive()) throw new NoPassphraseError();
  const passphrase = await ask(prompter, source.confirm ? 'New passphrase for mn: ' : 'Passphrase for mn: ');
  if (source.confirm) {
    const again = await ask(prompter, 'Passphrase again: ');
    if (again !== passphrase) throw new UsageError('The two passphrases do not match.');
  }
  return passphrase;
}

/** True once mn's passphrase is set on this machine. */
export function isPassphraseSet(root: string = stateRoot()): boolean {
  return fs.existsSync(keystorePath(root));
}

/** Sets mn's one passphrase. Refused when one is set already. */
export function establishPassphrase(root: string, passphrase: string): void {
  const file = keystorePath(root);
  if (fs.existsSync(file)) throw new UsageError(`mn's passphrase is already set (${file}).`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  // `wx`: never over a check another process wrote meanwhile.
  fs.writeFileSync(file, JSON.stringify({ check: sealSecret(CHECK_VALUE, passphrase, 'keystore-check') }, null, 2) + '\n', { mode: FILE_MODE, flag: 'wx' });
}

/** Refuses `passphrase` unless it is the one set. */
export function checkPassphrase(root: string, passphrase: string): void {
  const { check } = JSON.parse(fs.readFileSync(keystorePath(root), 'utf8')) as { check: unknown };
  openSecret(check, passphrase, 'keystore-check');
}

/** The shortest passphrase mn accepts when one is set. */
export const MIN_PASSPHRASE_LENGTH = 12;

// The passphrase this process has unlocked, by state root: one prompt per run.
const unlocked = new Map<string, string>();

/**
 * mn's passphrase, read and checked against the one set; asked for once per
 * run. One already checked is taken again only when the environment names no
 * other: a changed MN_PASSPHRASE is checked afresh.
 */
export async function unlockPassphrase(root: string = stateRoot(), source: PassphraseSource = {}): Promise<string> {
  const known = unlocked.get(root);
  const fromEnv = source.env !== undefined ? source.env[PASSPHRASE_ENV] : settings().passphrase;
  if (known !== undefined && (fromEnv === undefined || fromEnv === '' || fromEnv === known)) return known;
  if (!isPassphraseSet(root)) throw new UsageError('mn has no passphrase yet. Set one with: midnight wallet protect');
  const passphrase = await readPassphrase(source);
  checkPassphrase(root, passphrase);
  unlocked.set(root, passphrase);
  return passphrase;
}

/**
 * The passphrase to seal a new secret under: the one set, or, on a machine
 * with none yet, a new one (asked twice at a terminal), which is then set.
 */
export async function passphraseForNewSecret(root: string = stateRoot(), source: PassphraseSource = {}): Promise<string> {
  if (isPassphraseSet(root)) return unlockPassphrase(root, source);
  const passphrase = await readPassphrase({ ...source, confirm: true });
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) {
    throw new UsageError(`mn's passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  establishPassphrase(root, passphrase);
  unlocked.set(root, passphrase);
  return passphrase;
}
