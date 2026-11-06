// The rc engine's facade, stopped, leaves nothing that keeps a program's process up (test-support/facade-stop-suite.ts).

import { resolve } from 'node:path';
import { facadeStopSuite } from '../../../../test-support/facade-stop-suite.ts';

facadeStopSuite({ set: 'rc', facadeModule: resolve(import.meta.dirname, '..', 'facade.ts'), asksNodeForLiveness: true });
