// The DApp connector's tests over the rc engine (preprod, preview, undeployed).
// The tests are the suite both engines run: helpers/connector-suite.ts.

import { createDAppConnector, signatureScheme, toHistoryEntry } from '@kuiralabs/midnight-engine-rc/dapp-connector';
import { PartlySignedTransactionError } from '@kuiralabs/midnight-engine-rc/sign-recipe';
import { FORK_SCHEDULE } from '@kuiralabs/midnight-engine-rc/fork-schedule';
import { deriveAllShieldedAddresses, deriveShieldedAddress, deriveUnshieldedAddress } from '@kuiralabs/midnight-engine-rc/derive-address';
import * as ledger from '@midnightntwrk/ledger-v9';
import { createKeystore } from '@midnightntwrk/wallet-sdk/unshielded';
import { DustAddress, MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { connectorSuite } from './helpers/connector-suite.ts';

connectorSuite({
  set: 'rc',
  createDAppConnector,
  signatureScheme,
  toHistoryEntry,
  PartlySignedTransactionError,
  deriveUnshieldedAddress,
  deriveAllShieldedAddresses,
  deriveShieldedAddress,
  DustAddress,
  UnshieldedAddress,
  MidnightBech32m,
  ledger,
  createKeystore,
  SubmissionError,
  ledger9ProtocolVersion: FORK_SCHEDULE.v9,
  // The rc SDK reads a dApp's transaction through adoptTransaction, which the stub answers with its stage and hex.
  readsThroughFacade: true,
  handleHex: (handle: { hex?: string; serialize?: () => Uint8Array }) => handle.hex ?? Buffer.from(handle.serialize!()).toString('hex'),
});
