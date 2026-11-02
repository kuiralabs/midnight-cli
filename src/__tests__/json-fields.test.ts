// What a command writes with --json is what its definition says it writes:
// every top-level field of its result is one its help's JSON fields name, so
// `help --json` and the agent manual describe what agents really get. Run for
// the commands that need no network, with a temporary home.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../lib/argv.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import { captureCommand } from '../lib/run-command.ts';
import type { CommandHandler } from '../lib/call-context.ts';
import { ownCall } from './helpers/own-call.ts';

const PASSPHRASE = 'correct horse battery staple';
let home: string;
const originalHome = process.env.HOME;
const originalPassphrase = process.env.MN_PASSPHRASE;

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-json-fields-')));
  process.env.HOME = home;
  process.env.MN_PASSPHRASE = PASSPHRASE;
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalPassphrase === undefined) delete process.env.MN_PASSPHRASE;
  else process.env.MN_PASSPHRASE = originalPassphrase;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Runs the command as an agent asking for the full shape would, and returns its result. */
async function run(...argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs([...argv, '--json']);
  args.flags._full = true;
  const { default: handler } = await installedCommands.find(args.command!)!.load();
  return captureCommand(handler as CommandHandler, args, ownCall());
}

// In order: a later run reads what an earlier one wrote. Each run lists the
// fields it writes that its help doesn't name yet: wallet's and generate's help
// predate what they write, and correcting help is a change to what users and
// agents read, waiting on the owner's approval. A field missing from help that
// isn't listed here fails, and so does a listed one once help names it.
const runs: ReadonlyArray<readonly [argv: readonly string[], notYetInHelp: readonly string[]]> = [
  [['wallet', 'generate', 'alice'], ['addresses', 'shieldedAddresses', 'activeAddress', 'activeNetwork', 'seed', 'file', 'createdAt', 'mnemonic']],
  [['wallet', 'generate', 'bob'], ['addresses', 'shieldedAddresses', 'activeAddress', 'activeNetwork', 'seed', 'file', 'createdAt', 'mnemonic']],
  [['wallet', 'use', 'alice'], ['wallet']],
  [['wallet', 'list'], ['activeNetwork']],
  [['wallet', 'info', 'bob'], ['addresses', 'activeAddress', 'activeNetwork', 'createdAt', 'file', 'shieldedAddresses']],
  [['info'], []],
  [['address', '--seed', 'aa'.repeat(32), '--network', 'undeployed'], []],
  [['genesis-address', '--network', 'undeployed'], []],
  [['config', 'set', 'network', 'preview'], []],
  [['config', 'get', 'network'], []],
  [['config', 'unset', 'network'], []],
  [['cache', 'clear'], []],
  [['generate', '--output', 'legacy.json'], ['addresses', 'activeAddress', 'activeNetwork']],
];

describe('every field a command writes with --json is one its definition names', () => {
  it.each(runs.map(([argv, notYetInHelp]) => [argv.join(' '), argv, notYetInHelp] as const))('%s', async (_name, argv, notYetInHelp) => {
    const declared = Object.keys(installedCommands.find(argv[0]!)!.help?.jsonFields ?? {});
    const written = Object.keys(await run(...argv.map((a) => (a === 'legacy.json' ? path.join(home, a) : a))));
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((field) => !declared.includes(field)).sort()).toStrictEqual([...notYetInHelp].sort());
  });
});
