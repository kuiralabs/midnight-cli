// Runs the wallet SDK's own choice of fee coins on the case it never returned
// from up to wallet SDK 2.0.0-rc.0: a wallet whose only coin covers the
// payment's own fee but not the fee with its spend added. Prints "returned"
// when it does. Run as its own
// process by dust-wallet.test.ts, which stops it: the loop is synchronous.

import { Transacting } from '@midnightntwrk/wallet-sdk/dust/v2';
import { CAPTURED_AT, computeArguments, feeRange, paymentToBalance, timeWhenSmallestReaches, transacting } from './dust-balancing-case.ts';

const payment = await paymentToBalance();
const inRange = timeWhenSmallestReaches(feeRange(payment, CAPTURED_AT).own);
process.stdout.write('started\n');
transacting(Transacting.TransactingCapabilityImplementation, { onlySmallest: true }).computeBalancingRecipe(...computeArguments(payment, inRange));
process.stdout.write('returned\n');
