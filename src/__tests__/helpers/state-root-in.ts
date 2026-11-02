// The state root the CLI would keep under a test's home: its .midnight folder.

import { join } from 'node:path';
import { MIDNIGHT_DIR } from '@kuiralabs/midnight-cli-core/lib/constants';

export const stateRootIn = (home: string): string => join(home, MIDNIGHT_DIR);
