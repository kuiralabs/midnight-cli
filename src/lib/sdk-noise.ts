// A shell concern: the process-wide filters for the SDK's noise, installed
// once by the CLI and the MCP server at start. They act only while a call is
// listening (its context's sdkWarnings), which is where the suppression they
// replace used to be switched on; at any other time the console and
// unhandled rejections behave as they would without them (an unhandled
// rejection is printed and exits 1). Libraries never install them.
//
//   - A transient Wallet.* rejection is retried by the SDK: it goes to the
//     listening call, and the run goes on. Any other unhandled rejection is
//     printed and exits 1, as Node does.
//   - The SDK's Wallet.* stack traces on console.error, and polkadot-js's
//     RPC-CORE lines on console.warn and console.error (one per failed
//     submit), are kept off the terminal.
//
// Which call a warning belongs to: each call runs inside its own
// AsyncLocalStorage store, the one ambient per-call storage the process-safety
// check allows, so a warning raised while it runs carries its identity, and
// the host's router hands it to that call alone (lib/sdk-warnings.ts).
// Measured on 31 Oct 2026 with two calls at once: on Node (v25) the identity
// survives the SDK's WebSocket callbacks (ws, polkadot-js, graphql-ws through
// the SDK's subscription client), Effect fibers, timers, RxJS, and reaches the
// unhandledRejection handler; under bun (1.3) it survives timers, RxJS and
// Effect fibers but is lost on everything resumed from a WebSocket. A warning
// that lost it is never given to the wrong call: the router gives it to the
// one call listening, or to none.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createSdkWarningRouter, sdkTransientWarning, type SdkWarningCalls } from './sdk-warnings.ts';

let installed: SdkWarningCalls | null = null;

/** Installs the filters, once; the calls the host runs, whose SDK warnings go to the call that raised them. */
export function installSdkNoiseFilters(): SdkWarningCalls {
  if (installed !== null) return installed;

  const router = createSdkWarningRouter();
  const runningCall = new AsyncLocalStorage<number>();
  const report = (tag: string, message: string): void => router.route(runningCall.getStore(), tag, message);

  const originalError = console.error;
  const originalWarn = console.warn;
  const isRpcNoise = (args: unknown[]) => args.some((a) => String(a).includes('RPC-CORE'));

  process.on('unhandledRejection', (reason) => {
    const warning = router.isListening() ? sdkTransientWarning(reason) : null;
    if (warning !== null && typeof reason !== 'string') {
      report(warning.tag, warning.message);
      return;
    }
    originalError('Unhandled rejection:', reason);
    process.exit(1);
  });

  console.error = (...args: unknown[]) => {
    if (!router.isListening()) return originalError(...args);
    const warning = sdkTransientWarning(args[0]);
    if (warning !== null) {
      report(warning.tag, warning.message);
      return;
    }
    if (isRpcNoise(args)) return;
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (router.isListening() && isRpcNoise(args)) return;
    originalWarn(...args);
  };

  installed = {
    run: (run) => {
      const call = router.openCall();
      return runningCall.run(call.id, () => run(call.warnings));
    },
  };
  return installed;
}
