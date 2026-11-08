// mn's fee settings as they reach the wallet SDK: the configuration buildFacade
// gives WalletFacade.init carries the wallet's own settings object, the SDK's
// Dust wallet keeps that object, and mn's Dust transacting prices with the
// margin it holds at the time of each price. Runs the SDK and the ledger on
// the real two-coin wallet state and a real payment.

import { beforeAll, describe, expect, it } from 'vitest';
import type * as ledger from '@midnightntwrk/ledger-v9';
import { DustWallet as SdkDustWallet, dustVariantConfigurations } from '@midnightntwrk/wallet-sdk/dust';
import { newFeePricing } from '@kuiralabs/midnight-cli-core/engine';
import { getNetworkConfig } from '@kuiralabs/midnight-cli-core';
import { facadeConfiguration } from '../facade.ts';
import { ConvergingDustTransacting } from '../dust-wallet.ts';
import { ledgerParams, paymentToBalance, transacting } from './helpers/dust-balancing-case.ts';

let payment: ledger.FinalizedTransaction;

beforeAll(async () => {
  payment = await paymentToBalance();
});

describe('the fee settings a facade is built with', () => {
  it('are the wallet\'s own settings object: no overhead, 3 blocks of margin', () => {
    const pricing = newFeePricing();
    const configuration = facadeConfiguration('undeployed', getNetworkConfig('undeployed'), pricing);

    expect(configuration.costParameters).toBe(pricing);
    expect(configuration.costParameters).toEqual({ additionalFeeOverhead: 0n, feeBlocksMargin: 3 });
  });

  it("stay that object in the configuration the SDK builds its ledger-9 Dust wallet from", () => {
    const pricing = newFeePricing();
    // As the facade hands it to the Dust wallet's builder.
    const configuration: Parameters<typeof SdkDustWallet>[0] = facadeConfiguration('undeployed', getNetworkConfig('undeployed'), pricing);
    const { v2 } = dustVariantConfigurations(configuration);

    expect(v2.costParameters).toBe(pricing);
  });

  it("price each fee with the margin they hold at the time: the ledger's fee with that many blocks", () => {
    const pricing = newFeePricing();
    const mine = transacting(ConvergingDustTransacting, { costParameters: pricing });

    expect(mine.calculateFee(payment, ledgerParams)).toBe(payment.feesWithMargin(ledgerParams, 3));
    pricing.feeBlocksMargin = 5;
    expect(mine.calculateFee(payment, ledgerParams)).toBe(payment.feesWithMargin(ledgerParams, 5));
    expect(payment.feesWithMargin(ledgerParams, 5)).toBeGreaterThan(payment.feesWithMargin(ledgerParams, 3));
  });
});
