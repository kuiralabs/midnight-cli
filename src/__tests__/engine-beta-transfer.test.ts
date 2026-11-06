// The beta engine's transfer amounts: helpers/engine-transfer-suite.ts.

import { createBetaEngine } from '@kuiralabs/midnight-engine-beta';
import { engineTransferSuite } from './helpers/engine-transfer-suite.ts';

engineTransferSuite({ set: 'beta', createEngine: createBetaEngine });
