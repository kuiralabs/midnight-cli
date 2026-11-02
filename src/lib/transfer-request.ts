// A transfer's arguments, checked before any wallet starts: the CLI checks them
// before syncing, the MCP server before it issues a confirmation token, so a
// typo in the amount or the recipient is refused up front.

import { type ParsedArgs, getFlag, hasFlag } from '@kuiralabs/midnight-cli-core/lib/argv';
import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { loadWalletConfig, resolveWalletPath, type WalletConfig } from './wallet-config.ts';
import { resolveNetworkName } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { engineFor, type EngineKeys } from '@kuiralabs/midnight-cli-core/lib/engine';
import { shieldedSyncEnabled, shieldedDisabledReason } from '@kuiralabs/midnight-cli-core/lib/shielded-policy';
import { parseAmount } from '@kuiralabs/midnight-cli-core/lib/amount';
import type { NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';

export interface TransferRequest {
  walletPath: string;
  walletConfig: WalletConfig;
  networkName: NetworkName;
  /** The recipient's bech32m address; a wallet name given as the recipient is resolved to it. */
  recipientAddress: string;
  amountNight: number;
  shielded: boolean;
}

/** `transfer <to> <amount> [--shielded] [--wallet] [--network]`, checked without touching the chain. */
export async function resolveTransferRequest(args: ParsedArgs): Promise<TransferRequest> {
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
  const recipientAddress = await resolveRecipient(recipientInput, args, shielded);
  const amountNight = parseAmount(amountStr);
  const walletPath = resolveWalletPath(getFlag(args, 'wallet'));
  const walletConfig = await loadWalletConfig(walletPath);
  const networkName = resolveNetworkName({ args });

  if (shielded) {
    if (!shieldedSyncEnabled(networkName, hasFlag(args, 'force-shielded'))) {
      throw new Error(shieldedDisabledReason(networkName));
    }
  }
  assertRecipient((await engineFor(networkName)).keys, recipientAddress, shielded, networkName);

  return { walletPath, walletConfig, networkName, recipientAddress, amountNight, shielded };
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
 * An address (mn_addr_ or mn_shield-addr_ prefix) is used as given. Anything
 * else is a wallet name, and the address comes from that wallet's file.
 */
async function resolveRecipient(input: string, args: ParsedArgs, shielded: boolean): Promise<string> {
  if (input.startsWith('mn_addr_') || input.startsWith('mn_shield-addr_')) {
    return input;
  }

  const recipientConfig = await loadWalletConfig(resolveWalletPath(input));
  const networkName = resolveNetworkName({ args });

  if (shielded) {
    const shieldedAddr = recipientConfig.shieldedAddresses?.[networkName];
    if (!shieldedAddr) {
      throw new Error(
        `Wallet "${input}" has no shielded address for network "${networkName}".\n` +
        `Regenerate the wallet or run "midnight balance --shielded" first.`
      );
    }
    return shieldedAddr;
  }

  const address = recipientConfig.addresses[networkName];
  if (!address) {
    throw new Error(`Wallet "${input}" has no address for network "${networkName}". Regenerate the wallet to derive one.`);
  }
  return address;
}
