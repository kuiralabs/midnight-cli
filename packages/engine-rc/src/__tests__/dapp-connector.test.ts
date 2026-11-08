// The DApp connector's tests over the rc engine (preprod, preview, undeployed).
// The tests are the shared suite: test-support/connector-suite.ts.

import { createDAppConnector, signatureScheme, toHistoryEntry } from '../dapp-connector.ts';
import { PartlySignedTransactionError } from '../sign-recipe.ts';
import { FORK_SCHEDULE } from '../fork-schedule.ts';
import { deriveAllShieldedAddresses, deriveShieldedAddress, deriveUnshieldedAddress } from '../derive-address.ts';
import * as ledger from '@midnightntwrk/ledger-v9';
import { createKeystore } from '@midnightntwrk/wallet-sdk/unshielded';
import { DustAddress, MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { connectorSuite } from '../../../../test-support/connector-suite.ts';

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
  handleHex: (handle: { hex?: string; serialize?: () => Uint8Array }) => handle.hex ?? Buffer.from(handle.serialize!()).toString('hex'),
});
