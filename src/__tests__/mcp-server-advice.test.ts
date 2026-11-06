// A call the MCP server can't take because of the SDK set it runs is told to use a server of its own.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OtherSdkSetError } from '@kuiralabs/midnight-cli-core';
import { withServerAdvice } from '../lib/mcp/server-advice.ts';

// A state root with no config: every network on the set the table names.
const ROOT = mkdtempSync(join(tmpdir(), 'mn-server-advice-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('the MCP server\'s advice for a call on the other SDK set', () => {
  it('names the networks of the set it can\'t load, and says to start a server for them', () => {
    const advised = withServerAdvice(new OtherSdkSetError('rc', 'beta'), ROOT);
    expect(advised).toBeInstanceOf(OtherSdkSetError);
    expect(advised).toMatchObject({ code: 'OTHER_SDK_SET', loadedSet: 'rc', wantedSet: 'beta' });
    expect(advised.message).toBe("This MCP server runs the rc SDK set, and stagenet runs on the beta set: two sets' ledgers can't share a process. Start another MCP server for stagenet and make the call there.");
  });

  it('names every network of the rc set the other way round', () => {
    expect(withServerAdvice(new OtherSdkSetError('beta', 'rc'), ROOT).message).toContain('and mainnet, preprod, preview, undeployed run on the rc set');
  });

  it('leaves every other error as it was', () => {
    const error = new Error('something else');
    expect(withServerAdvice(error, ROOT)).toBe(error);
  });
});
