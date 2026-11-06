# @kuiralabs/midnight-engine-rc

The Midnight CLI's engine for the SDK's release candidates (wallet SDK 2.0 rc, ledger 9 rc, midnight-js 5 rc): everything the CLI packages do with that SDK set (wallets, the ledger, contracts, readers, the account package) behind core's engine interface. It runs preprod, preview and a local network (`undeployed`). Only an engine imports the SDK; the other packages reach it through the engine your host loads.

## Install

```sh
npm install @kuiralabs/midnight-cli-core@next @kuiralabs/midnight-engine-rc@next
```

Install with npm 11 or older (npm 12 no longer reads a package's shrinkwrap): this package ships an `npm-shrinkwrap.json` that pins its SDK set, and npm 11 honours it, so it gets exactly the SDK it was tested with (one copy of each ledger). An install that isn't that tree (bun's installer ignores the shrinkwrap and resolves the packages again) is refused before any SDK module loads, with `MIXED_SDK_LAYOUT` and the npm command; bun can run what npm installed. A program that also uses stagenet (`@kuiralabs/midnight-engine-beta`) installs both; a process loads one of them.

## Entry points

| Import | What it holds |
|---|---|
| `@kuiralabs/midnight-engine-rc` | `createRcEngine(host)`: the engine, for a host's `engineLoader` |

Every export and its signature is in [api-report.md](https://github.com/kuiralabs/midnight-cli/blob/main/packages/engine-rc/api-report.md).

## Codes

This package owns no codes of its own. The SDK's errors are read once, here, and given core's codes (`PROOF_FAILURE`, `TX_REJECTED`, `STALE_UTXO` and the rest, in core's README), so a program never matches the SDK's messages.

## Loading it

A host loads an engine the first time a call needs one, by the SDK set of the call's network: `rc` for preprod, preview and a local network, `beta` for stagenet. A process runs one set; a call on a network of the other set fails with `OTHER_SDK_SET`, so a program that needs both runs two processes.

```js
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '@kuiralabs/midnight-cli-core';

// One process runs one SDK set: the loader imports only the engine of the set asked for.
const host = createHost({
  paths: { stateRoot: join(homedir(), '.my-app'), home: homedir() },
  engineLoader: async (set, host) => set === 'rc'
    ? (await import('@kuiralabs/midnight-engine-rc')).createRcEngine(host)
    : (await import('@kuiralabs/midnight-engine-beta')).createBetaEngine(host),
});

const engine = await host.engines.for('undeployed');
const seed = Buffer.from(process.env.WALLET_SEED, 'hex');
console.log(engine.set, engine.keys.unshieldedAddress(seed, 'undeployed'));
```

With `WALLET_SEED` a seed in hex, it prints `rc` and the wallet's first address on undeployed (`mn_addr_undeployed1…`). A test in mn runs the block above as it is written.
