// A shell concern: the process-wide filters for the SDK's noise, installed
// once by the CLI and the MCP server at start. Libraries never install them;
// they listen for the warnings through sdk-warnings.ts.
//
//   - A transient Wallet.* rejection is retried by the SDK: it goes to the
//     listening library, and the run goes on. Any other unhandled rejection
//     is printed and exits 1, as Node does.
//   - The SDK's Wallet.* stack traces on console.error, and polkadot-js's
//     RPC-CORE lines on console.warn and console.error (one per failed
//     submit), are kept off the terminal.

import { reportSdkWarning, sdkTransientWarning } from './sdk-warnings.ts';

let installed = false;

export function installSdkNoiseFilters(): void {
  if (installed) return;
  installed = true;

  const originalError = console.error;
  const originalWarn = console.warn;
  const isRpcNoise = (args: unknown[]) => args.some((a) => String(a).includes('RPC-CORE'));

  process.on('unhandledRejection', (reason) => {
    const warning = sdkTransientWarning(reason);
    if (warning !== null && typeof reason !== 'string') {
      reportSdkWarning(warning.tag, warning.message);
      return;
    }
    originalError('Unhandled rejection:', reason);
    process.exit(1);
  });

  console.error = (...args: unknown[]) => {
    const warning = sdkTransientWarning(args[0]);
    if (warning !== null) {
      reportSdkWarning(warning.tag, warning.message);
      return;
    }
    if (isRpcNoise(args)) return;
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (isRpcNoise(args)) return;
    originalWarn(...args);
  };
}
