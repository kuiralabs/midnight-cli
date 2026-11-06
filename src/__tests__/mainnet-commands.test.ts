// Mainnet moves real value. mn acts on it only when a command names it, and
// refuses there, before anything runs, what only makes sense on a test network
// (a faucet, a test suite's throwaway contracts, the dev loop) or has no
// released build there (mn grant). The commands run as the MCP server runs
// them, in a state root of the test's own; nothing reaches a network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertKnownFlags, captureCommand, classifyError, createHost, MIDNIGHT_DIR, parseArgs, settingsFromEnvironment, UsageError } from '@kuiralabs/midnight-cli-core';
import { configDefinition } from '@kuiralabs/midnight-cli-core/commands';
import { airdropDefinition } from '@kuiralabs/midnight-wallet/commands';
import { testDefinition } from '@kuiralabs/midnight-dev/commands';
import { grantDefinition } from '@kuiralabs/midnight-grant/commands';
import { installedCommands } from '../lib/installed-commands.ts';
import { loadInstalledEngine } from '../../test-support/test-host.ts';
import { ownCall } from './helpers/own-call.ts';

let home: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-mainnet-')));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A call in the test's own state root, with nothing in its environment but what it is given. */
function call() {
  const host = createHost({
    paths: { stateRoot: path.join(home, MIDNIGHT_DIR), home },
    settings: settingsFromEnvironment({ MN_NO_LOCAL_DETECT: '1' }),
    engineLoader: loadInstalledEngine,
  });
  return ownCall({ host });
}

/** What `argv` fails with, run as an MCP tool runs it. */
async function failureOf(definition: Parameters<typeof captureCommand>[0], argv: string[]): Promise<Error> {
  const err = await captureCommand(definition, parseArgs(argv), call()).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('commands refused on mainnet before anything runs', () => {
  it('airdrop: mainnet has no faucet', async () => {
    const err = await failureOf(airdropDefinition, ['airdrop', '100', '--network', 'mainnet']);
    expect(classifyError(err, installedCommands)).toEqual({ exitCode: 2, errorCode: 'MAINNET_REFUSED' });
    expect(err.message).toContain('mainnet has no faucet');
  });

  it('a shielded airdrop too', async () => {
    const err = await failureOf(airdropDefinition, ['airdrop', '100', '--shielded', '--network', 'mainnet']);
    expect(classifyError(err, installedCommands).errorCode).toBe('MAINNET_REFUSED');
  });

  it('mn test create: a suite deploys throwaway contracts, and nothing is written', async () => {
    const dapp = path.join(home, 'dapp');
    fs.mkdirSync(dapp);
    const err = await failureOf(testDefinition, ['test', 'create', '--network', 'mainnet', '--path', dapp, '--no-ai']);
    expect(classifyError(err, installedCommands).errorCode).toBe('MAINNET_REFUSED');
    expect(err.message).toContain('throwaway contracts');
    expect(fs.readdirSync(dapp)).toEqual([]);
  });

  it('mn test run: a dapp.test.json naming mainnet, and no results are written', async () => {
    const dapp = path.join(home, 'dapp');
    fs.mkdirSync(dapp);
    fs.writeFileSync(path.join(dapp, 'dapp.test.json'), JSON.stringify({ name: 'on-mainnet', network: 'mainnet', prep: [] }));
    const cwd = process.cwd();
    process.chdir(dapp);
    try {
      const err = await failureOf(testDefinition, ['test', 'run']);
      expect(classifyError(err, installedCommands).errorCode).toBe('MAINNET_REFUSED');
    } finally {
      process.chdir(cwd);
    }
    expect(fs.readdirSync(dapp)).toEqual(['dapp.test.json']);
  });

  it('mn grant, every subcommand: the account has no released build for mainnet, and no records are made', async () => {
    for (const argv of [['grant', 'deploy'], ['grant', 'status'], ['grant', 'list']]) {
      const err = await failureOf(grantDefinition, [...argv, '--network', 'mainnet']);
      expect(classifyError(err, installedCommands).errorCode).toBe('MAINNET_REFUSED');
      expect(err.message).toContain('no released key set');
    }
    expect(fs.existsSync(path.join(home, MIDNIGHT_DIR, 'accounts'))).toBe(false);
  });

  it('mn dev: it takes no --network, so mainnet can\'t be named to it', () => {
    expect(() => assertKnownFlags(parseArgs(['dev', '--network', 'mainnet']), installedCommands)).toThrow(UsageError);
  });
});

describe('mainnet only when named per command', () => {
  it('config set network mainnet is refused, and the saved network stays', async () => {
    const err = await failureOf(configDefinition, ['config', 'set', 'network', 'mainnet']);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toContain('--network mainnet');
    const result = await captureCommand(configDefinition, parseArgs(['config', 'get', 'network']), call());
    expect(result).toEqual({ action: 'get', key: 'network', value: 'undeployed' });
  });

  it('mainnet\'s Blockfrost project id is set with config set, and shown masked with its network', async () => {
    await captureCommand(configDefinition, parseArgs(['config', 'set', 'blockfrost-project-id', 'nightmainnetZyXwVuTsRqPoNmLkJiHg9876']), call());
    const result = await captureCommand(configDefinition, parseArgs(['config', 'get', 'blockfrost-project-id', '--network', 'mainnet']), call());
    expect(result.value).toBe('nightmainnet…9876 (mainnet)');
  });
});
