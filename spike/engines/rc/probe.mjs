import { makeProbe } from './probe-core.mjs';

export const probe = makeProbe({
  set: 'rc',
  facadeSpecifier: '@midnightntwrk/wallet-sdk/facade',
  contractsSpecifier: '@midnight-ntwrk/midnight-js-contracts',
  // The rc dust wallet's v1 is its ledger-8 variant; v2 is the ledger-9 one.
  dustLedger9Specifier: '@midnightntwrk/wallet-sdk/dust/v2',
});
