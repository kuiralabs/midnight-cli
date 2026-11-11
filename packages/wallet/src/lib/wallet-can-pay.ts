// Whether a wallet can pay for a transaction: it holds unshielded NIGHT and
// has Dust for the fee. Read through the wallet repository, so no facade, no
// proof server and no strict sync is needed. A refusal names what was to be
// paid for and says what pays a fee: Dust, which only unshielded NIGHT
// registered for Dust generation generates (shielded NIGHT generates none).

import { NATIVE_TOKEN_TYPE, DustRequiredError, InsufficientBalanceError, LOCAL_WALLET_FUNDING_NIGHT, throwIfCancelled, nightAmountText, type Engine, type NetworkConfig, type NetworkName, type PayingTarget } from '@kuiralabs/midnight-cli-core';
import { formatNight, type Spinner } from '@kuiralabs/midnight-cli-core/ui';
import { getChainGenesisHash } from '@kuiralabs/midnight-chain';
import { resolveWalletPath, unlockWallet } from './wallet-config.ts';

/** What a refusal says the payment was for when the caller names nothing. */
const UNNAMED_PAYMENT = 'this transaction';

/** What the check found of a wallet that can't pay, for the refusal to say. */
export interface PaymentShortfall {
  network: NetworkName;
  /** What the payment is for ("deploying escrow"); UNNAMED_PAYMENT when not given. */
  paying?: string;
  /** The wallet's unshielded address on the network. */
  address: string;
  /** The --wallet the command was given (undefined: the active wallet), repeated in the commands it suggests. */
  wallet: string | undefined;
  /** Unshielded NIGHT, in its smallest unit. */
  unshieldedNight: bigint;
  /** Shielded NIGHT, in its smallest unit; undefined when it was not read (only the local network's is). */
  shieldedNight?: bigint;
}

/**
 * The refusal for a wallet with no unshielded NIGHT: what was to be paid
 * for, that fees are paid in Dust and only registered unshielded NIGHT
 * generates it (shielded NIGHT held is counted and said to pay nothing), and
 * the steps that make the wallet able to pay on its network.
 */
export function noNightError({ network, paying = UNNAMED_PAYMENT, address, wallet, shieldedNight }: PaymentShortfall): InsufficientBalanceError {
  const walletFlag = wallet === undefined ? '' : ` --wallet ${wallet}`;
  const networkFlag = ` --network ${network}`;
  const holdsShielded = shieldedNight !== undefined && shieldedNight > 0n;
  const held = holdsShielded ? ` It holds ${nightAmountText(shieldedNight)} shielded NIGHT, which can't pay a fee.` : '';
  const send = `another wallet sends it: midnight transfer ${address} <amount>`;
  const source = network === 'undeployed'
    ? [`     midnight airdrop${walletFlag}   (${LOCAL_WALLET_FUNDING_NIGHT} NIGHT from the local genesis wallet)`, `     or ${send}`]
    : network === 'mainnet'
      ? [`     ${send}`]
      : [`     the Midnight faucet for ${network}, or ${send}`];
  return new InsufficientBalanceError(
    `Can't pay for ${paying} on ${network}: the wallet has no unshielded NIGHT.${held}\n` +
    `Fees are paid in Dust, and Dust comes only from unshielded NIGHT registered for Dust generation; shielded NIGHT generates none.\n\n` +
    `  1. Get unshielded NIGHT to ${address}:\n` +
    source.join('\n') + '\n' +
    (holdsShielded ? `     (mn can't move this wallet's own shielded NIGHT to its unshielded address.)\n` : '') +
    `  2. Register it for Dust generation:\n` +
    `     midnight dust register${walletFlag}${networkFlag}\n`,
  );
}

/** The refusal for a wallet whose unshielded NIGHT generates no Dust: what was to be paid for, and how to register it. */
export function noDustError({ network, paying = UNNAMED_PAYMENT, wallet, unshieldedNight }: PaymentShortfall): DustRequiredError {
  const flags = `${wallet === undefined ? '' : ` --wallet ${wallet}`} --network ${network}`;
  return new DustRequiredError(
    `Can't pay for ${paying} on ${network}: the wallet has ${nightAmountText(unshieldedNight)} unshielded NIGHT and no Dust. Fees are paid in Dust, which unshielded NIGHT generates once it is registered for Dust generation.\n\n` +
    `  Register it:\n` +
    `    midnight dust register${flags}\n` +
    `  Then see its Dust grow:\n` +
    `    midnight dust status${flags}\n`,
  );
}

/** A wallet's shielded NIGHT, for a refusal to count; undefined when it can't be read (the refusal stands either way). */
async function shieldedNightOf(engine: Engine, seed: Buffer, network: NetworkName, networkConfig: NetworkConfig, root: string, progress: Spinner, signal: AbortSignal | undefined): Promise<bigint | undefined> {
  progress.update('Checking shielded NIGHT...');
  try {
    const chainId = (await getChainGenesisHash(networkConfig.node, signal)) ?? undefined;
    return (await engine.readers.shieldedBalance(seed, network, networkConfig.indexerWS, { root, chainId, signal })).balance;
  } catch {
    throwIfCancelled(signal);
    return undefined;
  }
}

/**
 * The wallet holds unshielded NIGHT and has Dust to pay a fee with. Throws,
 * saying what to do, when it has neither. `wallet` is the --wallet flag;
 * without it the active wallet is checked, the one the command's server will
 * use. `paying` names what the payment is for ("deploying escrow") in a
 * refusal. Returns what it found, the Dust in Specks.
 */
export async function assertWalletCanPay({ network, root, host, networkConfig }: PayingTarget, wallet: string | undefined, progress: Spinner, signal?: AbortSignal, paying?: string): Promise<{ nightBalance: bigint; dustBalance: bigint }> {
  throwIfCancelled(signal);
  const walletConfig = await unlockWallet(resolveWalletPath(root, wallet), { root, host });
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];
  const { sdkSetOf } = await import('@kuiralabs/midnight-cli-core');
  const engine = await host.engines.load(sdkSetOf(network, root));
  const repo = engine.wallet;

  try {
    // Two cheap reads through the repo: no facade, no proof server, no strict
    // sync. Its tip-aware memo makes the next check in the same MCP session
    // nearly free.
    const balanceView = await repo.unshieldedBalance(address, networkConfig, { signal });
    const nightBalance = balanceView.balances.get(NATIVE_TOKEN_TYPE) ?? 0n;

    if (nightBalance === 0n) {
      // Shielded NIGHT pays no fee, but a wallet holding some is told so. Read
      // on the local network only: there it takes seconds, while a hosted
      // network's first shielded read takes minutes.
      const shieldedNight = network === 'undeployed' ? await shieldedNightOf(engine, seedBuffer, network, networkConfig, root, progress, signal) : undefined;
      progress.fail('No unshielded NIGHT');
      throw noNightError({ network, paying, address, wallet, unshieldedNight: nightBalance, shieldedNight });
    }

    const dustView = await repo.dustBalance(seedBuffer, networkConfig, { root, notice: host.notice, signal, onStatus: (s) => progress.update(s) });
    if (dustView.balance === 0n && dustView.availableCoins === 0) {
      progress.fail('No dust available');
      throw noDustError({ network, paying, address, wallet, unshieldedNight: nightBalance });
    }

    progress.stop(`Wallet OK (${formatNight(nightBalance)}, dust available)`);
    return { nightBalance, dustBalance: dustView.balance };
  } catch (err) {
    progress.fail('Wallet check failed');
    throw err;
  }
}
