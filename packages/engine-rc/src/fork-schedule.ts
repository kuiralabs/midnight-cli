// The SDK's fork schedule for the chains this build targets, which the
// wallet facade reads chains by.

import { ProtocolVersion } from '@midnightntwrk/wallet-sdk';

/**
 * Where ledger-v9 starts reading each chain, by protocol version. The SDK picks
 * the ledger version from this, and a wrong value doesn't degrade gracefully:
 * it makes the wrong ledger read the chain.
 *
 * Ledger-v9 reads from protocol version 2000000 (the SDK's v9-native fork
 * version). It serves both kinds of chain mn runs on: a chain born on
 * ledger 9 (the localnet reports 2001000), and one that forked from ledger 8
 * (mainnet and the reset Preview: their ledger-8 history carries 1.x
 * versions, below the boundary, and the fork enacts runtime 2001100, above
 * it; no block falls between the two).
 */
export const FORK_SCHEDULE: ProtocolVersion.ForkSchedule = ProtocolVersion.V9NativeForkSchedule;
