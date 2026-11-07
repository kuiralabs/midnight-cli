// Folders and files mn keeps secrets and settings in are its user's alone:
// folders 0700, files 0600. A mode given at creation holds only for what mn
// creates, so a folder or file an earlier mn (or the user) left wider is
// narrowed when mn writes to it. Never widened: a narrower mode is kept.

import * as fs from 'node:fs';
import { DIR_MODE, FILE_MODE } from './constants.ts';

/** Takes away from `target` every permission `mode` doesn't grant. */
function narrowTo(target: string, mode: number): void {
  const current = fs.statSync(target).mode & 0o777;
  if ((current & ~mode) !== 0) fs.chmodSync(target, current & mode);
}

/** Makes `dir` (and any missing parent) owner-only, narrowing it when it exists with a wider mode. */
export function ensureOwnerOnlyDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  narrowTo(dir, DIR_MODE);
}

/** Narrows the file at `file` to owner-only, when it is wider. */
export function narrowToOwnerOnly(file: string): void {
  narrowTo(file, FILE_MODE);
}
