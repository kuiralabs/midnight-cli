// The rc engine's transfer amounts: helpers/engine-transfer-suite.ts.

import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
import { engineTransferSuite } from './helpers/engine-transfer-suite.ts';

engineTransferSuite({ set: 'rc', createEngine: createRcEngine });
