// A call the MCP server can't take because of the SDK set it runs is told to use a server of its own.

import { describe, expect, it } from 'vitest';
import { OtherSdkSetError } from '@kuiralabs/midnight-cli-core/lib/engine';
import { withServerAdvice } from '../lib/mcp/server-advice.ts';

describe('the MCP server\'s advice for a call on the other SDK set', () => {
  it('names the networks of the set it can\'t load, and says to start a server for them', () => {
    const advised = withServerAdvice(new OtherSdkSetError('rc', 'beta'));
    expect(advised).toBeInstanceOf(OtherSdkSetError);
    expect(advised).toMatchObject({ code: 'OTHER_SDK_SET', loadedSet: 'rc', wantedSet: 'beta' });
    expect(advised.message).toBe("This MCP server runs the rc SDK set, and stagenet runs on the beta set: two sets' ledgers can't share a process. Start another MCP server for stagenet and make the call there.");
  });

  it('names every network of the rc set the other way round', () => {
    expect(withServerAdvice(new OtherSdkSetError('beta', 'rc')).message).toContain('and preprod, preview, undeployed run on the rc set');
  });

  it('leaves every other error as it was', () => {
    const error = new Error('something else');
    expect(withServerAdvice(error)).toBe(error);
  });
});
