// Records a real swap offer for the offer reader's tests: on a local ledger-9
// chain whose genesis wallet (seed 0x…01) holds the dev chain's two shielded
// test tokens, it pays a new maker some of the first, then has the maker offer
// 10 of it for 7 of the second, paying no fee (the taker pays the swap's).
// The offer is never submitted. Writes swap-offer.ts beside this file.
//
//   MN_RECORD_NODE=ws://127.0.0.1:29944 MN_RECORD_INDEXER=http://127.0.0.1:28088 MN_RECORD_PROOF_SERVER=http://127.0.0.1:26300 \
//     npx tsx src/__tests__/fixtures/record-swap-offer.ts
//
// Run it only against a chain of your own.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsFromEnvironment, createHost, type NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { loadInstalledEngine } from '../../lib/installed-engines.ts';

const GIVE = '00'.repeat(31) + '01';
const WANT = '00'.repeat(31) + '02';
const GENESIS_SEED = Buffer.from('00'.repeat(31) + '01', 'hex');

const required = (name: string) => process.env[name] ?? (() => { throw new Error(`set ${name}`); })();
const indexer = required('MN_RECORD_INDEXER');
const networkConfig: NetworkConfig = {
  node: required('MN_RECORD_NODE'),
  indexer: `${indexer}/api/v4/graphql`,
  indexerWS: `${indexer.replace(/^http/, 'ws')}/api/v4/graphql/ws`,
  proofServer: required('MN_RECORD_PROOF_SERVER'),
  networkId: 'Undeployed',
};

const home = mkdtempSync(join(tmpdir(), 'mn-record-offer-'));
const root = join(home, '.midnight');
const host = createHost({ settings: () => settingsFromEnvironment(process.env), paths: { stateRoot: root, home }, engineLoader: loadInstalledEngine });

const engine = await host.engines.for('undeployed');
const ctx = { notify: () => {}, connectionId: 'record', requestId: 1, metadata: {} };
const open = (seed: Buffer) => engine.wallet.openConnector({
  seed, root, notice: () => {}, network: 'undeployed', networkConfig, address: engine.keys.unshieldedAddress(seed, 'undeployed'), syncMode: 'full',
  onMessage: (m) => { if (!/\d+\/\d+/.test(m)) process.stderr.write(`  ${m}\n`); },
});

const makerSeed = randomBytes(32);
const makerShielded = engine.keys.shieldedAddress(makerSeed, 'undeployed');

const genesis = await open(GENESIS_SEED);
try {
  const { tx } = await genesis.connector.handlers.makeTransfer({ desiredOutputs: [{ kind: 'shielded', type: GIVE, value: '100', recipient: makerShielded }] }, ctx) as { tx: string };
  const { txHash } = await genesis.connector.handlers.submitTransaction({ tx }, ctx) as { txHash: string };
  console.error(`  paid the maker: ${txHash}`);
} finally {
  await genesis.stop();
}

const maker = await open(makerSeed);
let offer: string;
try {
  for (let attempt = 1; ; attempt++) {
    const held = await maker.connector.handlers.getShieldedBalances({}, ctx) as Record<string, bigint>;
    if ((held[GIVE] ?? 0n) >= 10n) break;
    if (attempt > 60) throw new Error('the maker never received the token');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  ({ tx: offer } = await maker.connector.handlers.makeIntent({
    desiredInputs: [{ kind: 'shielded', type: GIVE, value: '10' }],
    desiredOutputs: [{ kind: 'shielded', type: WANT, value: '7', recipient: makerShielded }],
    options: { intentId: 'random', payFees: false },
  }, ctx) as { tx: string });
} finally {
  await maker.connector.revertPendingTxs('record').catch(() => {});
  await maker.stop();
}

writeFileSync(new URL('./swap-offer.ts', import.meta.url), `// A real swap offer: the maker gives 10 of the dev chain's shielded test token 1 for 7 of token 2, paying no fee.
// Made ${new Date().toISOString().slice(0, 10)} on a local ledger-9 chain (rc engine) by record-swap-offer.ts; never submitted.
export const OFFER_GIVE = '${GIVE}';
export const OFFER_WANT = '${WANT}';
export const SWAP_OFFER_HEX =
  '${offer}';
`);
console.error(`  wrote swap-offer.ts: ${offer.length / 2} bytes`);
