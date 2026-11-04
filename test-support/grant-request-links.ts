// A grant request link as an agent sends it, made by the agent entry of one
// copy of the account package: the copy an engine installs, so a test loads
// that copy's SDK set alone.

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

type Agent = typeof import('@kuiralabs/midnight-account-chain/agent');

/** A request for a payment to one coin key, from slot 3 of `account`, through the calling contract `caller` if one is named; made by the copy of the package in the folder `copy`. */
export async function agentLink(copy: string, account: string, caller?: Uint8Array): Promise<string> {
  const { freshGrantee, grantRequestFor, grantRequestLink } = (await import(pathToFileURL(path.join(copy, 'dist', 'src', 'entry', 'agent.js')).href)) as Agent;
  const identity = { account, clientId: 'rdns:org.example.agent', grantee: freshGrantee('k1'), readSecret: new Uint8Array(32).fill(7) };
  return grantRequestLink(grantRequestFor(identity, 3, new Uint8Array(32).fill(0x9a), 2, caller));
}
