# @kuiralabs/midnight-engine-rc

The Midnight CLI's engine for the ledger-9 SDK set (wallet SDK 2.0.0, ledger-v9 1.0.0, midnight-js 5.0.0, compact-runtime 0.21.0, compact-js 3.0.0, onchain-runtime-v4 4.0.0): everything the CLI packages do with that SDK set (wallets, the ledger, contracts, readers, the account package) behind core's engine interface. It runs mainnet, preprod, preview and a local network (`undeployed`). The SDK set is still named `rc` in the engine interface and the package name, from when it was built on the SDK's release candidates. Only an engine imports the SDK; the other packages reach it through the engine your host loads.

## Install

```sh
npm install @kuiralabs/midnight-cli-core @kuiralabs/midnight-engine-rc
```

Install with npm 11 or older (npm 12 no longer reads a package's shrinkwrap): this package ships an `npm-shrinkwrap.json` that pins its SDK set, and npm 11 honours it, so it gets exactly the SDK it was tested with (one copy of each ledger). An install that isn't that tree (bun's installer ignores the shrinkwrap and resolves the packages again) is refused before any SDK module loads, with `MIXED_SDK_LAYOUT` and the npm command; bun can run what npm installed.

## Entry points

| Import | What it holds |
|---|---|
| `@kuiralabs/midnight-engine-rc` | `createRcEngine(host)`: the engine, for a host's `engineLoader` |

Every export and its signature is in [api-report.md](https://github.com/kuiralabs/midnight-cli/blob/main/packages/engine-rc/api-report.md).

## Codes

This package owns no codes of its own. The SDK's errors are read once, here, and given core's codes (`PROOF_FAILURE`, `TX_REJECTED`, `STALE_UTXO` and the rest, in core's README), so a program never matches the SDK's messages.

## Loading it

A host loads the engine the first time a call needs one, for every network: its loader is given the SDK set (`rc`) and the host.

```js
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '@kuiralabs/midnight-cli-core';

// The loader imports the engine only when a call first needs it.
const host = createHost({
  paths: { stateRoot: join(homedir(), '.my-app'), home: homedir() },
  engineLoader: async (_set, host) => (await import('@kuiralabs/midnight-engine-rc')).createRcEngine(host),
});

const engine = await host.engines.for('undeployed');
const seed = Buffer.from(process.env.WALLET_SEED, 'hex');
console.log(engine.set, engine.keys.unshieldedAddress(seed, 'undeployed'));
```

With `WALLET_SEED` a seed in hex, it prints `rc` and the wallet's first address on undeployed (`mn_addr_undeployed1…`). A test in mn runs the block above as it is written.
