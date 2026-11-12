// Folders and files mn keeps secrets and settings in are its user's alone:
// folders 0700, files 0600. A mode given at creation holds only for what mn
// creates, so a folder or file an earlier mn (or the user) left wider is
// narrowed when mn writes to it. Never widened: a narrower mode is kept.

import * as fs from 'node:fs';
import { join } from 'node:path';
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

/**
 * Narrows everything under `dir` (and `dir` itself) to owner-only: folders
 * 0700, files 0600. Symbolic links are left alone, never followed. For a
 * store another library writes with the process's umask (LevelDB), whose
 * files mn can only tighten after they are made.
 */
export function narrowTreeToOwnerOnly(dir: string): void {
  narrowTo(dir, DIR_MODE);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) narrowTreeToOwnerOnly(at);
    else if (entry.isFile()) narrowTo(at, FILE_MODE);
  }
}
