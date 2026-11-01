// Whether a wallet can pay for a transaction: it holds NIGHT and has Dust for
// the fee. Read through the wallet repository, so no facade, no proof server
// and no strict sync is needed.

import { NATIVE_TOKEN_TYPE } from './constants.ts';
import { throwIfCancelled } from './errors.ts';
import type { NetworkName } from './network.ts';
import type { PayingTarget } from './payer.ts';
import { resolveWalletPath, unlockWallet } from './wallet-config.ts';
import { formatNight } from '../ui/format.ts';
import type { Spinner } from '../ui/spinner.ts';

/**
 * The wallet holds NIGHT and has Dust to pay a fee with. Throws, saying what
 * to do, when it has neither. `wallet` is the --wallet flag; without it the
 * active wallet is checked, the one the command's server will use. Returns
 * what it found, the Dust in Specks.
 */
export async function assertWalletCanPay({ network, networkConfig }: PayingTarget, wallet: string | undefined, progress: Spinner, signal?: AbortSignal): Promise<{ nightBalance: bigint; dustBalance: bigint }> {
  throwIfCancelled(signal);
  const walletConfig = await unlockWallet(resolveWalletPath(wallet));
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];
  const { defaultRepository } = await import('./wallet-data-repository.ts');
  const repo = defaultRepository();

  try {
    // Two cheap reads through the repo: no facade, no proof server, no strict
    // sync. Its tip-aware memo makes the next check in the same MCP session
    // nearly free.
    const balanceView = await repo.unshielded(address, networkConfig, { signal });
    const nightBalance = balanceView.balances.get(NATIVE_TOKEN_TYPE) ?? 0n;

    if (nightBalance === 0n) {
      progress.fail('No NIGHT balance');
      throw new Error(
        `Wallet has 0 NIGHT on ${network}.\n\n` +
        `  Fund your wallet before deploying:\n` +
        `    Address: ${address}\n` +
        (network === 'undeployed'
          ? `    Run: midnight airdrop 1000\n`
          : `    Use the Midnight faucet or transfer from another wallet.\n`)
      );
    }

    const dustView = await repo.dust(seedBuffer, networkConfig, { signal, onStatus: (s) => progress.update(s) });
    if (dustView.balance === 0n && dustView.availableCoins === 0) {
      progress.fail('No dust available');
      throw new Error(
        `Wallet has no dust on ${network}. Dust is required to pay transaction fees.\n\n` +
        `  Register for dust generation:\n` +
        `    Run: midnight dust register --network ${network}\n` +
        `    Then wait: midnight dust status --network ${network}\n`
      );
    }

    progress.stop(`Wallet OK (${formatNight(nightBalance)}, dust available)`);
    return { nightBalance, dustBalance: dustView.balance };
  } catch (err) {
    progress.fail('Wallet check failed');
    throw err;
  }
}
