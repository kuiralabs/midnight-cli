// The SDK's fork schedule for the chains this build targets, which the
// wallet facade reads chains by.

import { ProtocolVersion } from '@midnightntwrk/wallet-sdk';

/**
 * Where ledger-v9 starts reading each chain, by protocol version. The SDK picks
 * the ledger version from this, and a wrong value doesn't degrade gracefully:
 * it makes the wrong ledger read the chain.
 *
 * This build targets ledger-9-native chains (the localnet reports protocol
 * version 2001000). wallet-sdk 2.0 can't sync against today's ledger-8
 * indexers anyway: it needs the 4.4 indexer schema.
 *
 * When preview/preprod fork to ledger 9, their schedule needs the version
 * the hand-over is enacted at. A chain with ledger-8 history doesn't use
 * the v9-native schedule.
 */
export const FORK_SCHEDULE: ProtocolVersion.ForkSchedule = ProtocolVersion.V9NativeForkSchedule;
