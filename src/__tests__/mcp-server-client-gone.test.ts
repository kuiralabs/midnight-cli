// When the client goes away (the server's stdin closes), the MCP server
// cancels the calls still running and exits promptly. It used to run an
// in-flight call to its end first: a balance against an indexer that never
// answers held it for the read's whole timeout (60 s).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSilentNetwork, type SilentNetwork } from '../../test-support/stand-in-indexer.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

let home: string;
let network: SilentNetwork;

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-mcp-gone-')));
  network = await startSilentNetwork();
});
afterEach(async () => {
  await network.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const message = (body: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', ...body }) + '\n';

describe('the MCP server when its client goes away', () => {
  it('cancels the call still running and exits within a few seconds', async () => {
    const server = spawn(TSX, [path.join(REPO, 'src', 'mcp-server.ts')], {
      env: { ...process.env, HOME: home, NO_COLOR: '1', MN_NO_LOCAL_DETECT: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exited = new Promise<number | null>((resolve) => server.once('exit', (code) => resolve(code)));
    let stdout = '';
    server.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });

    server.stdin.write(message({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }));
    await expect.poll(() => stdout.includes('"id":1'), { timeout: 30_000, interval: 100 }).toBe(true);
    server.stdin.write(message({ method: 'notifications/initialized' }));
    const address = rcKeys.unshieldedAddress(Buffer.from('a1'.repeat(32), 'hex'), 'undeployed');
    server.stdin.write(message({ id: 2, method: 'tools/call', params: { name: 'midnight_balance', arguments: { address, network: 'undeployed', 'indexer-ws': network.indexerWS } } }));
    // The read is under way: it has connected to the indexer, which never answers.
    await expect.poll(() => network.opened.length, { timeout: 30_000, interval: 100 }).toBeGreaterThan(0);

    const closedAt = Date.now();
    server.stdin.end();
    const code = await exited;

    expect(Date.now() - closedAt).toBeLessThan(5_000);
    expect(code).toBe(0);
  }, 90_000);
});
