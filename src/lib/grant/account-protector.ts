// Grant's protector for `wallet protect` (decision 24): seals every
// plain-text account an earlier mn made, under the same passphrase as the
// wallets. The caller passes it to the wallet command. The sealing code (and
// the account chain it loads) is loaded only when the protector runs.

import type { WalletProtector } from '../wallet-protector.ts';

export const accountProtector: WalletProtector = {
  name: 'accounts',
  async protect(root, passphrase, coinKeyOf) {
    const { protectAllAccounts } = await import('./protect-account.ts');
    const report = await protectAllAccounts(root, passphrase, coinKeyOf);
    return {
      report,
      items: report.map((account) => {
        const subject = `account of ${account.wallet} on ${account.network}`;
        if ('error' in account) return { subject, error: account.error };
        return account.outcome === 'sealed-now'
          ? { subject, outcome: 'sealed-now' as const, sealedNote: 'owner key, records and private state encrypted' }
          : { subject, outcome: 'already-sealed' as const };
      }),
    };
  },
};
