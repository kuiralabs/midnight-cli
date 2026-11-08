// A contract script that meets a contract state the ledger can't decode: the
// state script decodes the bytes the indexer gave with midnight-js and the
// contract's runtime, and the call script's midnight-js does the same. Here a
// script, run as mn runs one, decodes a real ledger-9 state cut short; mn
// reports CONTRACT_STATE_UNREADABLE naming the contract, with the ledger's words.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ContractStateUnreadableError } from '@kuiralabs/midnight-cli-core';
import { SCRIPT_PRELUDE, executeScript, namingUnreadableState } from '../lib/contract/runner.ts';

const ADDRESS = '9f'.repeat(32);
const require = createRequire(import.meta.url);
const TYPES = pathToFileURL(require.resolve('@midnight-ntwrk/midnight-js-types')).href;
const RUNTIME = pathToFileURL(require.resolve('@midnight-ntwrk/compact-runtime')).href;
const NO_PACKAGES = { packages: [], packageFolder: () => null, set: 'rc' };

/** A script that decodes a contract state cut short by a byte, as the state script decodes what the indexer gave. */
const script = `${SCRIPT_PRELUDE}
import { SerializedContractState } from ${JSON.stringify(TYPES)};
import { ContractState } from ${JSON.stringify(RUNTIME)};
const whole = new ContractState().serialize();
SerializedContractState.fromBytes('v9', whole.slice(0, whole.length - 1)).deserialize({ v9: ContractState });
console.log('decoded');
`;

describe('a contract script that decodes a corrupt contract state', () => {
  it('fails as CONTRACT_STATE_UNREADABLE, the runner naming the contract', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-unreadable-state-'));
    try {
      const failure = await executeScript({ dir, script, overlaySdk: false, packages: NO_PACKAGES }).then(() => undefined, (e: unknown) => e);
      expect(failure).toMatchObject({ code: 'CONTRACT_STATE_UNREADABLE' });
      expect((failure as Error).message).toMatch(/^Unable to deserialize ContractState\. Error: /);

      const named = namingUnreadableState(failure, ADDRESS);
      expect(named).toBeInstanceOf(ContractStateUnreadableError);
      expect((named as Error).message).toContain(`Contract ${ADDRESS}'s state on chain can't be decoded by this mn's ledger (ledger 9): Unable to deserialize ContractState.`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves any other script failure as it is', () => {
    const other = Object.assign(new Error('Contract module does not export a ledger() function'), { code: undefined });
    expect(namingUnreadableState(other, ADDRESS)).toBe(other);
  });
});
