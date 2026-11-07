// A failure at mn serve as a contract run reports it, the whole way for real:
// the error a handler answers with, the wire (mn's code as data.mnCode), the
// generated script's RPC client and its marked failure line in a child Node,
// and the error the runner rebuilds from that line.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { SCRIPT_PRELUDE, executeScript, rpcClientCode } from '../../lib/contract/runner.ts';
import { createRpcServer } from '@kuiralabs/midnight-connect';
import { createHost } from '@kuiralabs/midnight-cli-core';

/**
 * How midnight-js 5 reports a provider's failure (its ProviderFailedError): its
 * own error naming the provider method, with the provider's error rebuilt on
 * `cause` as its class name and message only. The stand-in for the SDK's
 * wrapper around the script's call to mn serve.
 */
const MIDNIGHT_JS_WRAPS_IT = `
  .catch((e) => {
    const cause = new Error(e.message);
    cause.name = e.name;
    const wrapped = new Error("balanceTx rejected the transaction. The provider's own failure is on cause, with its message redacted.", { cause });
    wrapped.name = 'ProviderFailedError';
    wrapped.method = 'balanceTx';
    wrapped.code = 'PROVIDER_FAILED';
    throw wrapped;
  })`;

/** What the runner rejects with when a script's call to mn serve fails with what `failure` throws (`wrapped`: through midnight-js's provider wrapper, as a deploy or call meets it). */
export async function scriptFailureAtServe(failure: () => unknown, { wrapped = false }: { wrapped?: boolean } = {}): Promise<Error> {
  const server = createRpcServer({ host: createHost(), port: 0, refuseBrowsers: true, handlers: { connect: async () => ({ networkId: 'undeployed' }), balanceUnsealedTransaction: async () => { throw failure(); } } });
  const dir = mkdtempSync(join(tmpdir(), 'mn-script-wire-'));
  try {
    await server.ready;
    const { port } = server.wss.address() as AddressInfo;
    const wsModule = pathToFileURL(createRequire(import.meta.url).resolve('ws')).href;
    const script = SCRIPT_PRELUDE + rpcClientCode(port, wsModule) + `
await rpcConnect('undeployed');
await rpcCall('balanceUnsealedTransaction', { tx: 'ab' })${wrapped ? MIDNIGHT_JS_WRAPS_IT : ''};
`;
    return await executeScript({ dir, script, overlaySdk: false, packages: { packages: [], packageFolder: () => null, set: 'rc' } }).then(
      () => { throw new Error('expected the script to fail'); },
      (err: Error) => err,
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
