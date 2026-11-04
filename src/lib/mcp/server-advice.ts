// What the MCP server tells a call it can't take because of the SDK set it
// runs: a server loads one set's engine, so a call on a network of the other
// set is told to use a server of its own.

import { OtherSdkSetError, networksOnSdkSet } from '@kuiralabs/midnight-cli-core';

/** The server runs one SDK set: a call on the other set's network (by the config under the state root `root`) is told to use a server of its own. */
export function withServerAdvice(error: Error, root: string): Error {
  if (!(error instanceof OtherSdkSetError)) return error;
  const networks = networksOnSdkSet(error.wantedSet, root).join(', ');
  return new OtherSdkSetError(error.loadedSet, error.wantedSet,
    `This MCP server runs the ${error.loadedSet} SDK set, and ${networks} run${networks.includes(',') ? '' : 's'} on the ${error.wantedSet} set: two sets' ledgers can't share a process. Start another MCP server for ${networks} and make the call there.`);
}
