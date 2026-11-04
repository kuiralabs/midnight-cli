# @kuiralabs/midnight-cli-core

The base of the Midnight CLI packages: the host a program passes to them, typed errors and their codes, networks, settings and the state root, the wallet session, and the engine contract the SDK engines are built against.

## Your process: what mn's shell does that you must do

mn's shell does a few things to its own process so that the wallet SDK can run in it. A library never does them: it would be changing a process that is yours. When your program runs the SDK through these packages, the things below are yours to do, and core gives you the parts you can't write yourself in its `./process` entry point. Nothing in `./process` runs when you import it; you call it, once, at start.

### The setup

```js
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHost, openWalletSession } from '@kuiralabs/midnight-cli-core';
import { installSdkProcessGuard, syncHeapAdvice } from '@kuiralabs/midnight-cli-core/process';
import { createBetaEngine } from '@kuiralabs/midnight-engine-beta';

const guard = installSdkProcessGuard();
const heap = syncHeapAdvice();
if (heap) console.error(`A first sync may need more heap: start with NODE_OPTIONS=${heap.nodeOptions}`);
const stateRoot = join(homedir(), '.my-app');
const host = createHost({ paths: { stateRoot, home: homedir() }, notice: (line) => console.error(line), sdkWarnings: guard.calls, engineLoader: async (_set, host) => createBetaEngine(host) });
const cancel = new AbortController();
process.once('SIGINT', () => cancel.abort());

const session = await guard.calls.run((sdkWarnings) => openWalletSession({ seed: Buffer.from(process.env.WALLET_SEED, 'hex'), network: 'stagenet', root: stateRoot, notice: host.notice, engines: host.engines, sdkWarnings, signal: cancel.signal, onMessage: (line) => console.error(line) }));
try {
  console.log(await session.balances());
} finally {
  await session.close();
}
```

This opens a wallet on stagenet (which runs the beta SDK set, so the program loads the beta engine; preprod, preview and a local network run the rc engine, `createRcEngine` from `@kuiralabs/midnight-engine-rc`), prints what it holds, closes it, and ends by itself. `WALLET_SEED` is the wallet's seed in hex: 64 bytes from a mnemonic, or 32 raw. A test in this package runs the block above as it is written here, with only the engine standing in.

### What each part does

**A. The SDK's transient rejections.** During a sync the wallet SDK lets transient failures (`Wallet.Sync: Internal Server Error`, a dropped indexer socket) escape as unhandled promise rejections while it retries the work itself. Node exits 1 on an unhandled rejection, so without the guard your program dies in the middle of a sync. `installSdkProcessGuard()` installs one `unhandledRejection` handler: a transient `Wallet.*` rejection goes to the call that is listening for the SDK's warnings, and the program goes on. With no call listening, it goes to `onWarning` (a line on `console.warn` unless you give one). Any other unhandled rejection is printed and exits 1, as before. mn installs it with `outsideCalls: 'exit'`, which exits 1 on a transient rejection no call listens for; that is mn's choice, not the default. `guard.uninstall()` takes the handler off again.

**B. The SDK's console noise.** The SDK prints its retried failures as stack traces on `console.error`, and polkadot-js prints a `RPC-CORE` line for each failed submit. `installSdkProcessGuard({ console: true })` keeps both off the console while a call listens, handing the traces to that call as warnings; at any other time the console is untouched. It is off by default, because it replaces `console.error` and `console.warn`. polkadot-js's `API-WS` lines (a node connection lost and retried) are not filtered.

**C. Which call a warning belongs to.** `guard.calls.run(work)` runs `work` as one call and gives it its `sdkWarnings`; a warning raised while that call runs goes to that call alone. Pass them to `openWalletSession`: the session listens from the open until `close()`, and with `onMessage` you get each warning as a line, `SDK: <message>`. Pass `guard.calls` to `createHost` too, so library calls made through the host listen the same way.

**D. The heap a cold sync needs.** The first shielded or Dust sync of a wallet against a hosted network streams the chain's history through the SDK: its live working set stays near 300 MB, but short-lived objects took the heap to about 8.4 GB in a cold shielded sync measured on preprod. Under Node's default old-space limit (about 4 GB) the process can die with `JavaScript heap out of memory` before it writes the cache that makes every later sync cheap. The limit is fixed when Node starts, so no library can raise it. `syncHeapAdvice()` says whether this process's limit is too small on this machine and, if so, the flag to start with (`--max-old-space-size=16384`, or 70% of the machine's memory if that is less); it returns null when the limit will do. Start your program with that flag in `NODE_OPTIONS`, or re-run it with the flag before it loads the SDK, as mn's shell does. `syncHeapTargetMb(options)` is the same computation with every input given.

**E. Ctrl-C.** mn aborts the running work on SIGINT and SIGTERM and exits 5 seconds later whatever is still running. In a program, make one `AbortController`, abort it on the signal, and pass its `signal` to every call that takes one: an open that is cancelled stops what it started and rejects with `CancelledError`. Exiting after a grace period is your choice to make.

**F. Ending the process.** `await session.close()` reverts what the session built but never submitted, stops the wallet and closes what the engine opened: the indexer's sockets, the node client, the timers. After it, a program with nothing else to do ends by itself. mn still calls `process.exit` after a command that ran the SDK; a program does not have to.

**G. Blockfrost project ids.** Preprod's endpoints carry a Blockfrost project id in their URLs, and URLs end up in error messages and progress lines. mn hides them in everything it prints. Pass anything you print or log through `redactProjectId(text)` from this package; libraries you don't control (polkadot-js prints the URL it lost) write to the console themselves, so to catch those too, wrap your output streams as mn does.

### Node and bun

The guard works on both. On Node, a warning keeps the identity of the call it was raised in through the SDK's WebSocket callbacks, timers, RxJS and Effect fibers. Under bun (1.3) the identity is lost on everything resumed from a WebSocket: such a warning goes to the one call listening, or, with several listening, to none of them (never to the wrong one); either way it stays off the console while a call listens.

The heap advice is Node's: under bun `syncHeapAdvice()` returns null, because bun's heap is JavaScriptCore's and neither `NODE_OPTIONS` nor `--max-old-space-size` sets it. How much memory a cold sync takes under bun has not been measured.

### Troubleshooting

- **`Unhandled rejection:` with a `Wallet.Sync` error, then exit 1.** The guard isn't installed, or it was installed with `outsideCalls: 'exit'` and no call was listening. Install it before the first sync, and open the session inside `guard.calls.run` with `sdkWarnings`.
- **`JavaScript heap out of memory` during the first sync.** Start with the `NODE_OPTIONS` that `syncHeapAdvice()` names. Later syncs start from the cache and need far less.
- **The program doesn't end after it is done.** A session was not closed: every `openWalletSession` needs its `await session.close()`, also when the work in between threw (use `finally`). On Node, `process.getActiveResourcesInfo()` lists what is still open. If the SDK's wallets don't stop within 5 seconds the engine gives up waiting and what they hold stays open; then exit explicitly, as mn does.
- **`OtherSdkSetError`.** One process runs one SDK set: stagenet is on the beta set, the other networks on rc. A program that needs both runs two processes.
- **Warnings reach the console while a session is open.** Without `console: true` the guard leaves the console alone, so the SDK's traces print there; pass `console: true` to keep them off while a call listens.
