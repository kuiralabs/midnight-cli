// The errors mn grant refuses with before it reaches the account package: a
// network the package can't act on, a Node.js older than it needs, a wallet
// with no account yet. They import no account package, so a caller (the shell, the MCP
// server, a program classifying a failure) has them without loading the
// account chain and the SDK set it is built on.

import { UsageError } from '@kuiralabs/midnight-cli-core';

/** A network mn grant doesn't run the account package on yet: its current build was tested on a local network only. */
export class UnreachableByAccountError extends UsageError {
  constructor(networkId: string) {
    super(`mn grant runs on a local network (undeployed) only: the account contract's current build has been tested there and nowhere else; ${networkId} is not one.`);
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

/**
 * A proving key of the account contract couldn't be had: the installed
 * account build's keys are not published where the account package fetches
 * them (for a contract compiled with a compiler whose keys no release
 * carries yet), or the fetch failed.
 */
export class AccountKeysUnavailableError extends Error {
  readonly code = 'ACCOUNT_KEYS_UNAVAILABLE';
  /** The key's file in the build, as `keys/<circuit>.verifier`. */
  readonly file: string;

  constructor(file: string, message: string) {
    super(message);
    this.name = 'AccountKeysUnavailableError';
    this.file = file;
    Object.setPrototypeOf(this, AccountKeysUnavailableError.prototype);
  }
}
