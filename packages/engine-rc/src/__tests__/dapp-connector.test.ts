// The DApp connector's tests over the rc engine (preprod, preview, undeployed).
// The tests are the shared suite: test-support/connector-suite.ts.

import { describe, it, expect } from 'vitest';
import { createDAppConnector, OWN_COMMAND_APPROVALS, signatureScheme, toHistoryEntry } from '../dapp-connector.ts';
import { TEST_NETWORK_CONFIG, connectorStub } from '../../../../test-support/connector-stub.ts';
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

// Regression: the connector serving mn's own commands (swap, grant, contract)
// said "Auto-approved: <method>" for each request through the host's
// notices, which under --json land in the command's `warnings`.
describe("the connector serving mn's own command", () => {
  it('approves its requests without a word through the host\'s notices', async () => {
    const said: string[] = [];
    const { createBundleStub } = connectorStub({ createDAppConnector, deriveShieldedAddress, DustAddress, UnshieldedAddress, ledger9ProtocolVersion: FORK_SCHEDULE.v9 });
    const connector = createDAppConnector({ bundle: createBundleStub(), networkConfig: TEST_NETWORK_CONFIG, approvalOptions: OWN_COMMAND_APPROVALS, notice: (line) => said.push(line) });
    try {
      const signed = await connector.handlers.signData({ data: Buffer.from('hello').toString('hex'), options: { encoding: 'hex', keyType: 'unshielded' } }, { notify: () => {}, connectionId: 'conn_own', requestId: 1, metadata: {} });
      expect(signed).toBeDefined();
      expect(said.filter((line) => line.includes('Auto-approved'))).toEqual([]);
    } finally {
      connector.dispose();
    }
  });
});
