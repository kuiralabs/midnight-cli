// An rc engine made through its entry point, for tests outside the engine:
// its keys and addresses (what a wallet's addresses are compared with; every
// engine derives the same ones), its ledger reads and its contract scripts.

import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
import { testHost } from './test-host.ts';

export const rcEngine = createRcEngine(testHost());
export const rcKeys = rcEngine.keys;
