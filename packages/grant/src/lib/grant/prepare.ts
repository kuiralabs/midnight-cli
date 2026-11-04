// Everything `mn grant` settles before a wallet is opened: what is asked,
// which network, where the account's records are, whether there is an
// account yet, and for a command that starts one, that its wallet exists. The CLI runs it first; the MCP server runs it before it issues a
// confirmation token.

import { type ParsedArgs, getFlag, UsageError, type PayingTarget, resolvePayingTarget, type Host } from '@kuiralabs/midnight-cli-core';
import { assertWalletFileExists, getActiveWalletName, resolveWalletPath } from '@kuiralabs/midnight-wallet';
import { assertAccountNetwork, assertNodeRunsAccount } from './account.ts';
import { NoAccountError } from './account-errors.ts';
import { accountRecordsDir, accountWalletName, ensureAccountRecordsDir } from './account-records.ts';
import { type GrantRequest, resolveGrantRequest } from './request.ts';
import { contractAddressOnRecord } from './sealed-account.ts';

/** The account a wallet's records name. */
export interface AccountOnRecord {
  address: string;
}

export interface PreparedGrant {
  request: GrantRequest;
  target: PayingTarget;
  /** The name the account is kept under: the wallet's. */
  walletName: string;
  /** The account's records directory, which exists. */
  recordsDir: string;
  /** The account on record; null only for a deploy of a new one. */
  account: AccountOnRecord | null;
}

/** The account the records in `recordsDir` name, if any. Reads the records alone: no chain, no wallet. */
export async function accountOnRecord(recordsDir: string): Promise<AccountOnRecord | null> {
  // A sealed account keeps its address in clear beside its sealed records.
  const sealedAddress = contractAddressOnRecord(recordsDir);
  if (sealedAddress !== undefined) return { address: sealedAddress };
  const { directoryOwnerStore } = await import('@kuiralabs/midnight-account-chain/owner');
  const record = directoryOwnerStore(recordsDir).readOwner();
  return record === undefined ? null : { address: record.contractAddress };
}

export async function prepareGrant(args: ParsedArgs, root: string, host: Host): Promise<PreparedGrant> {
  const request = resolveGrantRequest(args);
  assertNodeRunsAccount();
  const target = resolvePayingTarget(args, 'grant', request.subcommand, root, host);
  // Refuses a network the account can't reach before anything is created.
  assertAccountNetwork(target.networkConfig, root);
  const walletName = accountWalletName(getFlag(args, 'wallet'), () => getActiveWalletName(root));
  const recordsDir = accountRecordsDir(target.network, walletName, root);
  const account = await accountOnRecord(recordsDir);
  if (request.subcommand === 'import' && account !== null) {
    throw new UsageError(`Wallet "${walletName}" already has an account on ${target.network} (${account.address}); a backup is never imported over one.`);
  }
  const makesItsOwn = request.subcommand === 'device' && request.action === 'new';
  if (makesItsOwn && account !== null) {
    throw new UsageError(`Wallet "${walletName}" already has an account on ${target.network} (${account.address}): a new device is made for a wallet with none.`);
  }
  if (request.subcommand !== 'deploy' && request.subcommand !== 'import' && !makesItsOwn && account === null) {
    throw new NoAccountError(walletName, target.network);
  }
  // Only a command that writes an account's first records makes their folder,
  // and only for a wallet there is: a command refused leaves nothing behind.
  if (account === null) {
    assertWalletFileExists(resolveWalletPath(root, getFlag(args, 'wallet')));
    ensureAccountRecordsDir(recordsDir);
  }
  return { request, target, walletName, recordsDir, account };
}
