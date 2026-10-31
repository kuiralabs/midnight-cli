// A shell concern: the process-wide filters for the SDK's noise, installed
// once by the CLI and the MCP server at start. They act only while a call is
// listening through sdk-warnings.ts, which is where the suppression they
// replace used to be switched on; at any other time the console and
// unhandled rejections behave as they would without them (an unhandled
// rejection is printed and exits 1). Libraries never install them.
//
//   - A transient Wallet.* rejection is retried by the SDK: it goes to the
//     listening library, and the run goes on. Any other unhandled rejection
//     is printed and exits 1, as Node does.
//   - The SDK's Wallet.* stack traces on console.error, and polkadot-js's
//     RPC-CORE lines on console.warn and console.error (one per failed
//     submit), are kept off the terminal.

import { isListeningForSdkWarnings, reportSdkWarning, sdkTransientWarning } from './sdk-warnings.ts';

let installed = false;

export function installSdkNoiseFilters(): void {
  if (installed) return;
  installed = true;

  const originalError = console.error;
  const originalWarn = console.warn;
  const isRpcNoise = (args: unknown[]) => args.some((a) => String(a).includes('RPC-CORE'));

  process.on('unhandledRejection', (reason) => {
    const warning = isListeningForSdkWarnings() ? sdkTransientWarning(reason) : null;
    if (warning !== null && typeof reason !== 'string') {
      reportSdkWarning(warning.tag, warning.message);
      return;
    }
    originalError('Unhandled rejection:', reason);
    process.exit(1);
  });

  console.error = (...args: unknown[]) => {
    if (!isListeningForSdkWarnings()) return originalError(...args);
    const warning = sdkTransientWarning(args[0]);
    if (warning !== null) {
      reportSdkWarning(warning.tag, warning.message);
      return;
    }
    if (isRpcNoise(args)) return;
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (isListeningForSdkWarnings() && isRpcNoise(args)) return;
    originalWarn(...args);
  };
}
