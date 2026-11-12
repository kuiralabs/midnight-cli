// `mn test create --strategy` takes cli or ui and reports the strategy by the
// name it was given: a ui suite was reported as "browser" (the name its suite
// file keeps), and "browser" was taken as input though nothing documents it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '@kuiralabs/midnight-cli-core';
import { testDefinition } from '@kuiralabs/midnight-dev/commands';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import { cliCall } from './helpers/cli-call.ts';

const { default: testCommand } = await testDefinition.load();

let home: string;
let dapp: string;
let io: CapturedOutput;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-test-create-strategy-'));
  // A dApp with one compiled contract.
  dapp = path.join(home, 'dapp');
  const compiler = path.join(dapp, 'managed', 'counter', 'compiler');
  fs.mkdirSync(compiler, { recursive: true });
  fs.writeFileSync(path.join(compiler, 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.30.0', 'language-version': '0.22.0', 'runtime-version': '0.15.0',
    circuits: [{ name: 'increment', pure: false, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } }],
    witnesses: [],
  }));
  io = captureOutput();
});
afterEach(() => {
  io.restore();
  fs.rmSync(home, { recursive: true, force: true });
});

const create = (...flags: string[]) => cliCall(testCommand, parseArgs(['test', 'create', '--path', dapp, '--no-ai', '--json', ...flags]));

describe('test create --strategy', () => {
  it('reports a ui suite as "ui"', async () => {
    await create('--strategy', 'ui', '--port', '4173', '--build-cmd', 'npm run dev');
    expect(JSON.parse(io.stdout())).toMatchObject({ subcommand: 'create', strategy: 'ui' });
  });

  it('reports a cli suite as "cli"', async () => {
    await create('--strategy', 'cli');
    expect(JSON.parse(io.stdout())).toMatchObject({ subcommand: 'create', strategy: 'cli' });
  });

  it('refuses "browser", naming cli and ui', async () => {
    await expect(create('--strategy', 'browser', '--port', '4173', '--build-cmd', 'npm run dev')).rejects.toThrow('Use "cli" or "ui"');
  });
});
