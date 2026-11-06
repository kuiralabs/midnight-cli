// mn grant issue on stagenet, run as the CLI runs it: the beta engine's copy
// of the account package pins no caller, so a request that pins its calling
// contract is refused with CALLER_PIN_UNSUPPORTED before the command asks for
// its payer, and so before any wallet is opened or transaction built; the
// same request without the pin gets as far as the payer. The home directory
// is a temporary one; nothing here reaches a chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs, NoPayerError } from '@kuiralabs/midnight-cli-core';
import { resolvedPackageFolder } from '@kuiralabs/midnight-cli-core/engine';
import { grantDefinition } from '@kuiralabs/midnight-grant/commands';
import { cliCall } from './helpers/cli-call.ts';
import { expectDeclared } from './helpers/expect-declared.ts';
import { agentLink } from '../../test-support/grant-request-links.ts';

const { default: grantCommand } = await grantDefinition.load();

const BETA_ENGINE = new URL('../../packages/engine-beta', import.meta.url).pathname;
const ENDPOINTS = ['--node', 'ws://127.0.0.1:9', '--indexer-ws', 'ws://127.0.0.1:9/api/v4/graphql/ws', '--proof-server', 'http://127.0.0.1:9'];
// An account's records as an earlier mn left them.
const ACCOUNT = '5e'.repeat(32);
const OWNER_RECORD = { contractAddress: ACCOUNT, deviceArm: 'k1', deviceSk: '4f'.repeat(32), bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) };

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-grant-stagenet-')));
  origHome = process.env.HOME;
  process.env.HOME = home;
  const records = path.join(home, '.midnight', 'accounts', 'stagenet', 'alice');
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, 'owner.json'), JSON.stringify(OWNER_RECORD));
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const issue = (link: string, ...flags: string[]) => cliCall(grantCommand, parseArgs(['grant', 'issue', link, ...flags, '--wallet', 'alice', '--network', 'stagenet', '--json', ...ENDPOINTS]));
const betaLink = (caller?: Uint8Array) => agentLink(resolvedPackageFolder(BETA_ENGINE, '@kuiralabs/midnight-account-chain')!, ACCOUNT, caller);

describe('mn grant issue on stagenet', () => {
  it('refuses a request that pins its calling contract before it asks for a payer, with CALLER_PIN_UNSUPPORTED', async () => {
    const link = await betaLink(new Uint8Array(32).fill(0xc4));
    for (const confirm of [[], ['--yes']]) {
      const refused = issue(link, ...confirm);
      await expect(refused).rejects.toMatchObject({ code: 'CALLER_PIN_UNSUPPORTED' });
      await refused.catch((err: unknown) => expectDeclared('grant', err));
    }
  });

  it('takes the same request without the pin as far as the payer it was given none of', async () => {
    await expect(issue(await betaLink(), '--yes')).rejects.toThrow(NoPayerError);
  });
});
