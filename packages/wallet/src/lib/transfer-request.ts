// A transfer's arguments, checked before any wallet starts: the CLI checks them
// before syncing, the MCP server before it issues a confirmation token, so a
// typo in the amount or the recipient is refused up front.

import * as fs from 'node:fs';
import { type ParsedArgs, getFlag, hasFlag, UsageError, resolveNetworkName, sdkSetOf, type EngineKeys, parseAmount, type NetworkName, looksLikeShieldedAddress, looksLikeUnshieldedAddress } from '@kuiralabs/midnight-cli-core';
import { loadWalletConfig, resolveWalletPath, walletAddress, walletShieldedAddress, type UnlockHost, type WalletConfig } from './wallet-config.ts';
import { assertShieldedTransferAllowed } from './wallet/transfer.ts';

export interface TransferRequest {
  walletPath: string;
  walletConfig: WalletConfig;
  networkName: NetworkName;
  /** The recipient's bech32m address; a wallet name given as the recipient is resolved to it. */
  recipientAddress: string;
  /** In NIGHT's smallest unit, exactly as written. */
  amount: bigint;
  shielded: boolean;
}

/** `transfer <to> <amount> [--shielded] [--wallet] [--network]`, checked without touching the chain, against the wallets and config under the state root `root`; a sealed recipient wallet is unlocked through `host`, and the recipient checked by its engine for the network. */
export async function resolveTransferRequest(args: ParsedArgs, root: string, host: UnlockHost): Promise<TransferRequest> {
  const recipientInput = args.subcommand;
  const amountStr = args.positionals[0];

  if (!recipientInput) {
    throw new UsageError(
      'Missing recipient address.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100\n' +
      'Example: midnight transfer alice 100'
    );
  }

  if (!amountStr) {
    throw new UsageError(
      'Missing amount.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100'
    );
  }

  const shielded = hasFlag(args, 'shielded');
  const recipientAddress = await resolveRecipient(recipientInput, args, shielded, root, host);
  const amount = parseAmount(amountStr);
  const walletPath = resolveWalletPath(root, getFlag(args, 'wallet'));
  const walletConfig = await loadWalletConfig(walletPath, host.engines);
  const networkName = resolveNetworkName({ args, configDir: root });

  // transferNight refuses it too; refused here before the wallet is opened, and before MCP issues a confirmation.
  if (shielded) assertShieldedTransferAllowed(networkName, hasFlag(args, 'force-shielded'));
  assertRecipient((await host.engines.load(sdkSetOf(networkName, root))).keys, recipientAddress, shielded, networkName);

  return { walletPath, walletConfig, networkName, recipientAddress, amount, shielded };
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
 * address comes from that wallet's file.
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

  if (shielded) {
    const shieldedAddr = await walletShieldedAddress(recipientPath, networkName, root, host);
    if (!shieldedAddr) {
      throw new Error(
        `Wallet "${input}" has no shielded address for network "${networkName}".\n` +
        `Regenerate the wallet or run "midnight balance --shielded" first.`
      );
    }
    return shieldedAddr;
  }

  const address = await walletAddress(recipientPath, networkName, root, host);
  if (!address) {
    throw new Error(`Wallet "${input}" has no address for network "${networkName}". Regenerate the wallet to derive one.`);
  }
  return address;
}
