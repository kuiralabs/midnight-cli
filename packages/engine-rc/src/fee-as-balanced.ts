// A dApp's transaction priced as the wallet will balance it. Balancing adds
// more than the wallet's Dust spend: a transaction that gives a contract a
// shielded coin (a circuit doing receiveShielded) leaves a shielded imbalance,
// and the wallet's shielded part adds a zswap offer for it (an input spending
// the wallet's coin, an output for the change), whose proofs and bytes the fee
// pays for. The facade's estimateTransactionFee prices the dApp's transaction
// alone: a call that moved a coin on preview was priced at 0.81 and 0.60 of what
// the chain charged. Here the shielded part balances the transaction first, as
// the facade's balancing does, the fee is estimated for the two together, and
// the coins it booked are released.

/** The wallet's parts that pricing uses: its shielded balancing (and the release of what it booked), and its Dust fee estimate. */
export interface BalancingWallets<Tx, Balancing extends Tx> {
  readonly shielded: {
    balanceTransaction(tx: Tx, ttl?: Date): Promise<Balancing | undefined>;
    revertTransaction(tx: Balancing): Promise<void>;
  };
  readonly dust: {
    estimateFee(transactions: readonly Tx[], ttl?: Date): Promise<bigint>;
  };
}

/**
 * The fee the wallet commits when it balances `tx`: its Dust estimate for
 * `tx` together with the shielded balancing the wallet adds to it (none when
 * `tx` owes no shielded coin). The coins the shielded balancing books are
 * released before this returns, whether the estimate succeeds or not; an
 * estimate's failure (a Dust shortfall) is the one thrown.
 */
export async function estimateFeeAsBalanced<Tx, Balancing extends Tx>(wallets: BalancingWallets<Tx, Balancing>, tx: Tx, ttl: Date): Promise<bigint> {
  const balancing = await wallets.shielded.balanceTransaction(tx, ttl);
  if (balancing === undefined) return wallets.dust.estimateFee([tx], ttl);
  let fee: bigint;
  try {
    fee = await wallets.dust.estimateFee([tx, balancing], ttl);
  } catch (err) {
    await wallets.shielded.revertTransaction(balancing).catch(() => { /* the estimate's failure is the one to say */ });
    throw err;
  }
  await wallets.shielded.revertTransaction(balancing);
  return fee;
}
