import { makeProbe } from './probe-core.mjs';

export const probe = makeProbe({
  set: 'beta',
  facadeSpecifier: '@midnightntwrk/wallet-sdk-facade',
  contractsSpecifier: '@midnight-ntwrk/midnight-js-contracts',
  dustLedger9Specifier: '@midnightntwrk/wallet-sdk-dust-wallet/v1',
});
