// The beta engine's coin picking, through garbage collection (test-support/coin-picking-gc.ts).

import { fileURLToPath } from 'node:url';
import { coinPickingSurvivesCollection } from '../../../../test-support/coin-picking-gc.ts';

coinPickingSurvivesCollection('beta', fileURLToPath(new URL('../shielded-wallet.ts', import.meta.url)));
