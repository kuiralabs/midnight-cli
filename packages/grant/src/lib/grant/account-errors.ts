// The errors mn grant refuses with before it reaches the account package: a
// network the package can't act on, a Node.js older than it needs, a wallet
// with no account yet, a grant request the network's account build can't
// hold. They import no account package, so a caller (the shell, the MCP
// server, a program classifying a failure) has them without loading the
// account chain and the SDK set it is built on.

import { UsageError } from '@kuiralabs/midnight-cli-core';

/** A network the account package can't reach yet. */
export class UnreachableByAccountError extends UsageError {
  constructor(networkId: string) {
    super(`mn grant runs on ledger 9, which only a local network (undeployed) and stagenet run so far; ${networkId} is not one.`);
    this.name = 'UnreachableByAccountError';
    Object.setPrototypeOf(this, UnreachableByAccountError.prototype);
  }
}

/**
 * A grant request that pins the contract calling the account, on a network
 * whose account build has no caller pin: stagenet's toolchain (compactc 0.33)
 * has no way for a contract to read its caller, so the account there can't
 * hold a grant to one.
 */
export class CallerPinUnavailableError extends Error {
  readonly code = 'CALLER_PIN_UNSUPPORTED';

  constructor(network: string, caller: string) {
    super(
      `The grant request pins the contract that calls the account (${caller}), and the account on ${network} can't pin a caller: its build there has no caller check. `
      + 'Ask the agent for a request that names no calling contract, or issue this one on a network whose account pins callers (undeployed).',
    );
    this.name = 'CallerPinUnavailableError';
    Object.setPrototypeOf(this, CallerPinUnavailableError.prototype);
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
