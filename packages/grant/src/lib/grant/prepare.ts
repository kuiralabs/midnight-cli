// Everything `mn grant` settles before a wallet is opened: what is asked,
// which network, where the account's records are, whether there is an
// account yet, for a command that starts one, that its wallet exists, and for
// an issue, that the network's account can hold the grant asked for. The CLI
// runs it first; the MCP server runs it before it issues a confirmation token.

import { type ParsedArgs, getFlag, UsageError, type PayingTarget, resolvePayingTarget, type Host } from '@kuiralabs/midnight-cli-core';
import { assertWalletFileExists, getActiveWalletName, resolveWalletPath } from '@kuiralabs/midnight-wallet';
import { type AccountChain, accountChainFor } from './account-chain.ts';
import { assertAccountNetwork, assertNodeRunsAccount } from './account.ts';
import { NoAccountError } from './account-errors.ts';
import { accountRecordsDir, accountWalletName, ensureAccountRecordsDir } from './account-records.ts';
import { assertCallerPinnable } from './owner-commands.ts';
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

/**
 * The account the records in `recordsDir` name, if any. Reads the records
 * alone: no chain, no wallet. Records in plain text are read by the account
 * package, which `chain` gives when they are looked for.
 */
export async function accountOnRecord(recordsDir: string, chain: () => Promise<AccountChain>): Promise<AccountOnRecord | null> {
  // A sealed account keeps its address in clear beside its sealed records.
  const sealedAddress = contractAddressOnRecord(recordsDir);
  if (sealedAddress !== undefined) return { address: sealedAddress };
  const { owner } = await chain();
  const record = owner.directoryOwnerStore(recordsDir).readOwner();
  return record === undefined ? null : { address: record.contractAddress };
}

export async function prepareGrant(args: ParsedArgs, root: string, host: Host): Promise<PreparedGrant> {
  const request = resolveGrantRequest(args);
  assertNodeRunsAccount();
  const target = resolvePayingTarget(args, 'grant', request.subcommand, root, host);
  // Refuses a network the account can't reach before anything is created.
  const network = assertAccountNetwork(target.networkConfig);
  const chain = () => accountChainFor(host.engines, network);
  const walletName = accountWalletName(getFlag(args, 'wallet'), () => getActiveWalletName(root));
  const recordsDir = accountRecordsDir(target.network, walletName, root);
  const account = await accountOnRecord(recordsDir, chain);
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
  if (request.subcommand === 'issue') await assertCallerPinnable(request.link, target.network, await chain());
  // Only a command that writes an account's first records makes their folder,
  // and only for a wallet there is: a command refused leaves nothing behind.
  if (account === null) {
    assertWalletFileExists(resolveWalletPath(root, getFlag(args, 'wallet')));
    ensureAccountRecordsDir(recordsDir);
  }
  return { request, target, walletName, recordsDir, account };
}
