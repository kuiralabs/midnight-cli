// A transfer's arguments, checked before any wallet starts: the CLI checks them
// before syncing, the MCP server before it issues a confirmation token, so a
// typo in the amount or the recipient is refused up front.

import * as fs from 'node:fs';
import { type ParsedArgs, getFlag, hasFlag, UsageError, resolveNetworkName, sdkSetOf, type EngineKeys, parseAmount, type NetworkName, looksLikeShieldedAddress, looksLikeUnshieldedAddress } from '@kuiralabs/midnight-cli-core';
import { loadWalletConfig, resolveWalletPath, unlockWallet, type UnlockHost, type WalletConfig } from './wallet-config.ts';
import { assertShieldedTransferAllowed } from './wallet/transfer.ts';
import { assertRecipientCount, readRecipientsFile, recipientLabel, recipientPairsOf, type RecipientEntry } from './transfer-recipients.ts';

/** One recipient of a transfer, resolved. */
export interface TransferRequestRecipient {
  /** As written: a wallet name or an address. */
  input: string;
  /** The recipient's bech32m address; a wallet name given as the recipient is resolved to it. */
  address: string;
  /** In NIGHT's smallest unit, exactly as written. */
  amount: bigint;
}

export interface TransferRequest {
  walletPath: string;
  walletConfig: WalletConfig;
  networkName: NetworkName;
  /** Who is paid, in order: one output each, in one transaction. A recipient listed twice is paid twice. */
  recipients: TransferRequestRecipient[];
  /** What all the recipients are paid together, in NIGHT's smallest unit. */
  total: bigint;
  shielded: boolean;
}

/**
 * `transfer <to> <amount> [<to> <amount> ...] [--to-file <file>] [--shielded]
 * [--wallet] [--network]`, checked without touching the chain, against the
 * wallets and config under the state root `root`; a sealed recipient wallet
 * is unlocked through `host`, and each recipient checked by its engine for
 * the network. With several recipients a refusal names the entry.
 */
export async function resolveTransferRequest(args: ParsedArgs, root: string, host: UnlockHost): Promise<TransferRequest> {
  const entries = recipientEntriesOf(args);
  assertRecipientCount(entries.length);

  const shielded = hasFlag(args, 'shielded');
  const walletPath = resolveWalletPath(root, getFlag(args, 'wallet'));
  const walletConfig = await loadWalletConfig(walletPath, host.engines);
  const networkName = resolveNetworkName({ args, configDir: root });

  // transferNight refuses it too; refused here before the wallet is opened, and before MCP issues a confirmation.
  if (shielded) assertShieldedTransferAllowed(networkName, hasFlag(args, 'force-shielded'));
  const keys = (await host.engines.load(sdkSetOf(networkName, root))).keys;

  const recipients: TransferRequestRecipient[] = [];
  for (const [index, entry] of entries.entries()) {
    recipients.push(await naming(index, entries.length, entry.to, async () => {
      const address = await resolveRecipient(entry.to, args, shielded, root, host);
      const amount = parseAmount(entry.amount);
      assertRecipient(keys, address, shielded, networkName);
      return { input: entry.to, address, amount };
    }));
  }
  const total = recipients.reduce((sum, recipient) => sum + recipient.amount, 0n);
  return { walletPath, walletConfig, networkName, recipients, total, shielded };
}

/** The recipients as written: from --to-file, or the `<to> <amount>` pairs after the command; both together is refused. */
function recipientEntriesOf(args: ParsedArgs): RecipientEntry[] {
  const words = [...(args.subcommand === undefined ? [] : [args.subcommand]), ...args.positionals];
  // A bare --to-file is refused by getFlag as needing a value.
  const file = getFlag(args, 'to-file');
  if (file === undefined) return recipientPairsOf(words);
  if (file === '') {
    throw new UsageError('--to-file needs the path of a JSON file of recipients.\nExample: midnight transfer --to-file payments.json');
  }
  if (words.length > 0) {
    throw new UsageError(
      `Give the recipients either as <to> <amount> pairs or with --to-file, not both (got ${words.map((word) => `"${word}"`).join(' ')} and --to-file ${file}).`
    );
  }
  return readRecipientsFile(file);
}

/** Runs one entry's checks; with several recipients a usage mistake names the entry. */
async function naming<T>(index: number, count: number, to: string, check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (err) {
    if (count === 1 || !(err instanceof UsageError)) throw err;
    throw new UsageError(`${recipientLabel(index, count, to)}: ${err.message}`);
  }
}

/** Refuses, as a usage mistake, a recipient that is not an address of that kind on the network. */
function assertRecipient(keys: EngineKeys, address: string, shielded: boolean, networkName: NetworkName): void {
  try {
    keys.assertAddress(address, shielded ? 'shielded' : 'unshielded', networkName);
  } catch (err: any) {
    throw new UsageError(shielded
      ? `Invalid shielded address: ${err.message}\nExpected a shielded address (mn_shield-addr_...) for network "${networkName}"`
      : `Invalid recipient address: ${err.message}\nExpected a bech32m address (mn_addr_...) for network "${networkName}"`);
  }
}

/**
 * An address (mn_addr or mn_shield-addr prefix, with mainnet's having no
 * network segment) is used as given. Anything else is a wallet name, and the
 * address comes from that wallet's file, opened to check it against its seed.
 */
async function resolveRecipient(input: string, args: ParsedArgs, shielded: boolean, root: string, host: UnlockHost): Promise<string> {
  if (looksLikeShieldedAddress(input) && !shielded) {
    throw new UsageError(
      `${input} is a shielded address: add --shielded to send it shielded NIGHT.\n` +
      'Example: midnight transfer mn_shield-addr_... 100 --shielded'
    );
  }
  if (looksLikeUnshieldedAddress(input) || looksLikeShieldedAddress(input)) {
    return input;
  }

  const recipientPath = resolveWalletPath(root, input);
  const networkName = resolveNetworkName({ args, configDir: root });
  if (!fs.existsSync(recipientPath)) {
    throw new UsageError(
      `Unknown recipient "${input}": it is neither an address nor one of your wallets.\n` +
      `Give the recipient's address (${shielded ? 'mn_shield-addr_...' : 'mn_addr_...'}), or the name of a wallet of yours (midnight wallet list shows them).`
    );
  }

  // Opened, so the address the file saves is checked against its seed
  // (WalletAddressMismatchError): a file edited to hold someone else's address
  // is never paid. The transfer needs mn's passphrase for the sender anyway.
  const recipient = await unlockWallet(recipientPath, { root, host });
  if (shielded) {
    const shieldedAddr = recipient.shieldedAddresses?.[networkName];
    if (!shieldedAddr) {
      throw new Error(
        `Wallet "${input}" has no shielded address for network "${networkName}".\n` +
        `Regenerate the wallet or run "midnight balance --shielded" first.`
      );
    }
    return shieldedAddr;
  }

  const address = recipient.addresses[networkName];
  if (!address) {
    throw new Error(`Wallet "${input}" has no address for network "${networkName}". Regenerate the wallet to derive one.`);
  }
  return address;
}
