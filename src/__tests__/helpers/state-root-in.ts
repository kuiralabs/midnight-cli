// The state root the CLI would keep under a test's home: its .midnight folder.

import { join } from 'node:path';
import { MIDNIGHT_DIR } from '../../lib/constants.ts';

export const stateRootIn = (home: string): string => join(home, MIDNIGHT_DIR);
