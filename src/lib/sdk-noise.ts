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

import { isSdkTransient, reportSdkWarning } from './sdk-warnings.ts';

let installed = false;

export function installSdkNoiseFilters(): void {
  if (installed) return;
  installed = true;

  const originalError = console.error;
  const originalWarn = console.warn;
  const isRpcNoise = (args: unknown[]) => args.some((a) => String(a).includes('RPC-CORE'));

  process.on('unhandledRejection', (reason) => {
    if (isSdkTransient(reason)) {
      reportSdkWarning((reason as { _tag: string })._tag, (reason as { message?: string }).message ?? 'transient error');
      return;
    }
    originalError('Unhandled rejection:', reason);
    process.exit(1);
  });

  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'object' && isSdkTransient(first)) {
      reportSdkWarning((first as { _tag: string })._tag, (first as { message?: string }).message ?? 'transient error');
      return;
    }
    if (typeof first === 'string' && isSdkTransient(first)) {
      reportSdkWarning('Wallet.Sync', 'transient error');
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
