// The account package (@kuiralabs/midnight-account-chain) as grant reaches
// it: through the engine, which installs the copy whose Midnight libraries
// (peer dependencies) are the engine's own SDK set. Grant never imports the
// package's code itself, only its types here: a copy it imported would
// resolve the package's libraries from grant's own folder.

import type * as Artefacts from '@kuiralabs/midnight-account-chain/artefacts';
import type * as Connector from '@kuiralabs/midnight-account-chain/connector';
import type * as Context from '@kuiralabs/midnight-account-chain/context';
import type * as Contract from '@kuiralabs/midnight-account-chain/contract';
import type * as Deposit from '@kuiralabs/midnight-account-chain/deposit';
import type * as Errors from '@kuiralabs/midnight-account-chain/errors';
import type * as Owner from '@kuiralabs/midnight-account-chain/owner';
import type { Engine, HostEngines, NetworkName } from '@kuiralabs/midnight-cli-core';

/** The account package's entry points grant uses, as one engine loaded them. */
export interface AccountChain {
  readonly artefacts: typeof Artefacts;
  readonly connector: typeof Connector;
  readonly context: typeof Context;
  readonly contract: typeof Contract;
  readonly deposit: typeof Deposit;
  readonly errors: typeof Errors;
  readonly owner: typeof Owner;
}

/** The account package as `engine` installs it. */
export async function accountChainOf(engine: Engine): Promise<AccountChain> {
  // Core leaves the modules untyped (it names none of the package's types); they are these entry points.
  return (await engine.account()) as AccountChain;
}

/** The account package as the engine for `network`'s SDK set installs it. */
export async function accountChainFor(engines: HostEngines, network: NetworkName): Promise<AccountChain> {
  return accountChainOf(await engines.for(network));
}
