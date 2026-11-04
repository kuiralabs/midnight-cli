// The errors mn grant refuses with before it reaches the account package: a
// network the package can't act on, a Node.js older than it needs, a wallet
// with no account yet. They import no account package, so a caller (the
// shell, the MCP server, a program classifying a failure) has them without
// loading the account chain and the SDK set it is built on.

import { UsageError, type SdkSet } from '@kuiralabs/midnight-cli-core';

/** A network the account package can't reach yet. */
export class UnreachableByAccountError extends UsageError {
  constructor(networkId: string, sdkSet: SdkSet = 'rc') {
    super(sdkSet === 'rc'
      ? `mn grant runs on ledger 9, which only a local network (undeployed) runs so far; ${networkId} is not one.`
      // The account package is built on the rc set: its contracts, proving files and providers.
      : `mn grant runs on the rc SDK set, and ${networkId} runs on the ${sdkSet} set. The account package has no ${sdkSet} build yet (its contracts need recompiling and new proving files), so grant can't act on it for now.`);
    this.name = 'UnreachableByAccountError';
    Object.setPrototypeOf(this, UnreachableByAccountError.prototype);
  }
}

/** The Node.js the account package needs: it declares 22.18 or newer. */
export const MIN_NODE_FOR_ACCOUNT = '22.18.0';

/** This Node.js is older than the account package needs. */
export class NodeTooOldForAccountError extends Error {
  readonly code = 'UNSUPPORTED_NODE';

  constructor(version: string) {
    super(`mn grant runs the account package, which needs Node.js ${MIN_NODE_FOR_ACCOUNT} or newer; this is Node.js ${version}. Install a current Node.js (https://nodejs.org) and run the command again.`);
    this.name = 'NodeTooOldForAccountError';
    Object.setPrototypeOf(this, NodeTooOldForAccountError.prototype);
  }
}

/** The wallet has no account to run an owner command on. */
export class NoAccountError extends Error {
  readonly code = 'NO_ACCOUNT';

  constructor(walletName: string, network: string) {
    super(`Wallet "${walletName}" has no account on ${network} yet.\nDeploy one: midnight grant deploy`);
    this.name = 'NoAccountError';
    Object.setPrototypeOf(this, NoAccountError.prototype);
  }
}
