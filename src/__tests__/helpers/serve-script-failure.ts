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
import { createRpcServer } from '../../lib/ws-rpc.ts';
import { createHost } from '@kuiralabs/midnight-cli-core/lib/host';

/** What the runner rejects with when a script's call to mn serve fails with what `failure` throws. */
export async function scriptFailureAtServe(failure: () => unknown): Promise<Error> {
  const server = createRpcServer({ host: createHost(), port: 0, refuseBrowsers: true, handlers: { balanceUnsealedTransaction: async () => { throw failure(); } } });
  const dir = mkdtempSync(join(tmpdir(), 'mn-script-wire-'));
  try {
    await server.ready;
    const { port } = server.wss.address() as AddressInfo;
    const wsModule = pathToFileURL(createRequire(import.meta.url).resolve('ws')).href;
    const script = SCRIPT_PRELUDE + rpcClientCode(port, wsModule) + `
await rpcConnect();
await rpcCall('balanceUnsealedTransaction', { tx: 'ab' });
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
