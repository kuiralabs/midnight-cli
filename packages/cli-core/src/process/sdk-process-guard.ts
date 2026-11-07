// The guard against the wallet SDK's transient rejections, for a host to
// install on its own process. No library installs it: only the host calls
// it, through core's "./process" entry point, which no package imports.
//
// During a sync the SDK lets transient failures (Wallet.Sync: Internal Server
// Error, a dropped indexer socket) escape as unhandled rejections while it
// retries the work itself. Node exits 1 on an unhandled rejection, so a
// program without the guard dies mid-sync. With it:
//
//   - A transient Wallet.* rejection goes to the call listening for the SDK's
//     warnings (a CallSdkWarnings from the guard's calls), and the run goes
//     on. With no call listening, `outsideCalls` decides: 'report' hands it to
//     `onWarning` and the run goes on; 'exit' prints it and exits 1, as Node
//     does without the guard. Any other unhandled rejection is printed and
//     exits 1.
//   - With `console`, while a call listens, the SDK's Wallet.* traces on
//     console.error go to that call too, and polkadot-js's RPC-CORE lines (one
//     per failed submit) and its logger's API lines (API/INIT, API-WS: a node
//     it can't reach, once every few seconds) on console.warn, console.error
//     and console.log are dropped. At any other time the console is untouched.
//
// Which call a warning belongs to: each call runs inside its own
// AsyncLocalStorage store, so a warning raised while it runs carries its
// identity, and the router hands it to that call alone (lib/sdk-warnings.ts).
// Measured on 31 Oct 2026 with two calls at once: on Node (v25) the identity
// survives the SDK's WebSocket callbacks (ws, polkadot-js, graphql-ws through
// the SDK's subscription client), Effect fibers, timers, RxJS, and reaches the
// unhandledRejection handler; under bun (1.3) it survives timers, RxJS and
// Effect fibers but is lost on everything resumed from a WebSocket. A warning
// that lost it is never given to the wrong call: the router gives it to the
// one call listening, or to none.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createSdkWarningRouter, sdkTransientWarning, type CallSdkWarnings, type SdkWarningCalls, type SdkWarningListener } from '../lib/sdk-warnings.ts';

export interface SdkProcessGuardOptions {
  /** While a call listens, hand the SDK's Wallet.* console.error traces to it and drop polkadot-js's RPC-CORE lines. Off by default: the console is left alone. */
  readonly console?: boolean;
  /**
   * A transient Wallet.* rejection while no call listens: 'report' (the
   * default) hands it to `onWarning` and the program goes on; 'exit' prints
   * it and exits 1, as Node does without the guard.
   */
  readonly outsideCalls?: 'exit' | 'report';
  /** Where 'report' sends a transient rejection no call listens for; a line on console.warn when not given. */
  readonly onWarning?: (tag: string, message: string) => void;
}

export interface SdkProcessGuard {
  /** The calls the host runs, each listening for its own SDK warnings: a host's `sdkWarnings`. */
  readonly calls: SdkWarningCalls;
  /** Takes the guard off the process: its rejection handler goes and the console is given back. */
  uninstall(): void;
}

/**
 * A line of polkadot-js's own logger about its API or its connection
 * ("API/INIT: …FATAL", "API-WS: disconnected from …"): it writes the date,
 * then its label (`API-WS:`, padded), then the message. mn reports a node it
 * can't reach itself (NETWORK_ERROR naming it), so these only repeat it.
 */
function isPolkadotApiLine(args: readonly unknown[]): boolean {
  return typeof args[0] === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(args[0])
    && typeof args[1] === 'string' && /^(API|RPC)[-/A-Z]*:$/.test(args[1].trim());
}

/** The line a reported warning prints when the host gives no `onWarning`. */
const reportOnConsole = (warn: (...args: unknown[]) => void): SdkWarningListener =>
  (tag, message) => warn(`${tag}: ${message} (a transient wallet SDK error; the SDK retries)`);

/**
 * Installs the guard on this process. Each call installs one more: a host
 * calls it once, at start, before the first wallet sync.
 */
export function installSdkProcessGuard(options: SdkProcessGuardOptions = {}): SdkProcessGuard {
  const outsideCalls = options.outsideCalls ?? 'report';
  const router = createSdkWarningRouter();
  const runningCall = new AsyncLocalStorage<number>();
  const report = (tag: string, message: string): void => router.route(runningCall.getStore(), tag, message);

  const originalError = console.error;
  const originalWarn = console.warn;
  const onWarning = options.onWarning ?? reportOnConsole(originalWarn);
  const isRpcNoise = (args: unknown[]) => args.some((a) => String(a).includes('RPC-CORE')) || isPolkadotApiLine(args);

  const onRejection = (reason: unknown): void => {
    // A rejection that is only a string is never the SDK's: its errors are objects with a _tag.
    const warning = typeof reason === 'string' ? null : sdkTransientWarning(reason);
    if (warning !== null && router.isListening()) {
      report(warning.tag, warning.message);
      return;
    }
    if (warning !== null && outsideCalls === 'report') {
      onWarning(warning.tag, warning.message);
      return;
    }
    originalError('Unhandled rejection:', reason);
    process.exit(1);
  };
  process.on('unhandledRejection', onRejection);

  const patchedError = (...args: unknown[]) => {
    if (!router.isListening()) return originalError(...args);
    const warning = sdkTransientWarning(args[0]);
    if (warning !== null) {
      report(warning.tag, warning.message);
      return;
    }
    if (isRpcNoise(args)) return;
    originalError(...args);
  };
  const patchedWarn = (...args: unknown[]) => {
    if (router.isListening() && isRpcNoise(args)) return;
    originalWarn(...args);
  };
  const originalLog = console.log;
  const patchedLog = (...args: unknown[]) => {
    if (router.isListening() && isPolkadotApiLine(args)) return;
    originalLog(...args);
  };
  if (options.console === true) {
    console.error = patchedError;
    console.warn = patchedWarn;
    console.log = patchedLog;
  }

  // Each running call's warnings, by its identity: which call a line raised now belongs to.
  const running = new Map<number, CallSdkWarnings>();
  return {
    calls: {
      run: (run) => {
        const call = router.openCall();
        running.set(call.id, call.warnings);
        return runningCall.run(call.id, () => run(call.warnings)).finally(() => running.delete(call.id));
      },
      current: () => {
        const id = runningCall.getStore();
        return id === undefined ? undefined : running.get(id);
      },
    },
    uninstall() {
      process.off('unhandledRejection', onRejection);
      // Given back only where nobody replaced them since.
      if (console.error === patchedError) console.error = originalError;
      if (console.warn === patchedWarn) console.warn = originalWarn;
      if (console.log === patchedLog) console.log = originalLog;
    },
  };
}
