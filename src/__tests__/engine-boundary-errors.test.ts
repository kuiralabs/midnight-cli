// The rc engine's failures as it reports them: helpers/engine-boundary-suite.ts,
// with the rc SDK's own error classes.

import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { ProvingError } from '@midnightntwrk/wallet-sdk/capabilities/proving';
import { InsufficientFundsError as NoCoinsCoverIt } from '@midnightntwrk/wallet-sdk/capabilities';
import { WalletError } from '@midnightntwrk/wallet-sdk/dust/v2';
import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
import { engineBoundarySuite } from './helpers/engine-boundary-suite.ts';

engineBoundarySuite({
  set: 'rc',
  createEngine: createRcEngine,
  SubmissionError,
  ProvingError,
  InsufficientFundsError: WalletError.InsufficientFundsError,
  couldNotBalance: (tokenType) => new NoCoinsCoverIt(tokenType).message,
});
