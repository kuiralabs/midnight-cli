// What mn refuses to do on mainnet: anything that only makes sense on a test
// network (a faucet, throwaway contracts) or that has no released build there.
// Each refusal happens before anything runs, and says why and what to do.

import type { NetworkName } from './network.ts';

/** A command or call that mn doesn't run on mainnet. */
export class MainnetRefusedError extends Error {
  readonly code = 'MAINNET_REFUSED';

  /** `what` is refused because `why`; `instead` says what to do. */
  constructor(what: string, why: string, instead: string) {
    super(`${what} is refused on mainnet: ${why}. Nothing was done.\n${instead}`);
    this.name = 'MainnetRefusedError';
    Object.setPrototypeOf(this, MainnetRefusedError.prototype);
  }
}

/** Throws MainnetRefusedError when `network` is mainnet. */
export function refuseOnMainnet(network: NetworkName, what: string, why: string, instead: string): void {
  if (network === 'mainnet') throw new MainnetRefusedError(what, why, instead);
}
