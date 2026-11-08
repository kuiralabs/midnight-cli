// A contract whose state on chain the ledger can't decode. The indexer is a
// local stand-in answering the state query with a real ledger-9 contract
// state cut short (real HTTP, real JSON); midnight-js and the ledger decode it
// as they would any. mn reports CONTRACT_STATE_UNREADABLE naming the contract,
// with what the ledger said, where it was UNKNOWN.

import { afterEach, describe, expect, it } from 'vitest';
import * as ledger from '@midnightntwrk/ledger-v9';
import { ContractStateUnreadableError, classifyError } from '@kuiralabs/midnight-cli-core';
import { rawContractState } from '../contract-providers.ts';
import { startLocalIndexer, type LocalIndexer } from '../../../../test-support/local-indexer.ts';
import { LEDGER9_PARAMETERS_HEX } from '../../../../test-support/fixtures/ledger9-parameters.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';
import { TEST_NETWORK_CONFIG } from '../../../../test-support/connector-stub.ts';

const ADDRESS = '9f'.repeat(32);
/** A contract state as the ledger writes it, cut short by a byte: its tag intact, its body not whole. */
const whole = Buffer.from(new ledger.ContractState().serialize());
const CORRUPT_STATE_HEX = whole.subarray(0, whole.length - 1).toString('hex');

let indexer: LocalIndexer | undefined;
afterEach(async () => { await indexer?.close(); indexer = undefined; });

const serving = async (stateHex: string) => {
  indexer = await startLocalIndexer(() => JSON.stringify({ data: { block: { height: 100, protocolVersion: 2001000, ledgerParameters: LEDGER9_PARAMETERS_HEX }, contract: { state: stateHex } } }));
  return { ...TEST_NETWORK_CONFIG, indexer: indexer.url, indexerWS: indexer.url.replace(/^http:/, 'ws:') + '/ws' };
};

describe('rawContractState of a contract whose state is corrupt on chain', () => {
  it('fails as CONTRACT_STATE_UNREADABLE, naming the contract, with what the ledger said', async () => {
    const err = await rawContractState(await serving(CORRUPT_STATE_HEX), ADDRESS).then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(ContractStateUnreadableError);
    expect((err as Error).message).toBe(
      `Contract ${ADDRESS}'s state on chain can't be decoded by this mn's ledger (ledger 9): Unable to deserialize ContractState. Error: failed to fill whole buffer. `
      + "That is the state the chain holds for the contract, not something in your setup: neither a read of its state nor a call of it can work until it is fixed on chain.",
    );
    expect(classifyError(err as Error, CORE_CODES)).toEqual({ exitCode: 1, errorCode: 'CONTRACT_STATE_UNREADABLE' });
  });

  it('reads a whole state as before', async () => {
    expect(await rawContractState(await serving(whole.toString('hex')), ADDRESS)).not.toBeNull();
  });
});
