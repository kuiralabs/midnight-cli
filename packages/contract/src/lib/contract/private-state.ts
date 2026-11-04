// A dApp's contract private state: the LevelDB store the midnight-js private
// state provider keeps in the dApp's folder, under its default name. It holds
// state keyed to the contracts of the chain it was made on, so once that chain
// is reset the store refers to contracts that no longer exist.

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/** The private state provider's database folder, in the folder it runs in. */
export const PRIVATE_STATE_DATABASE = 'midnight-level-db';

/** Removes the private-state store in `dappDir`. True iff there was one and it is gone. */
export function clearDappPrivateState(dappDir: string): boolean {
  const dir = resolve(dappDir, PRIVATE_STATE_DATABASE);
  if (!existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
