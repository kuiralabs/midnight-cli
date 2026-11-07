import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManual } from '../commands/manual.ts';
import { getConfigValue } from '@kuiralabs/midnight-cli-core';
import { installedCommands } from '../lib/installed-commands.ts';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('mn manual', () => {
  it('contains the canonical sections in order', () => {
    const m = stripAnsi(buildManual());
    const sections = [
      'NAME',
      'SYNOPSIS',
      'DESCRIPTION',
      'INSTALLATION',
      'CONCEPTS',
      'COMMANDS',
      'COMMON FLOWS',
      'CONFIGURATION',
      'JSON OUTPUT',
      'EXIT CODES',
      'TROUBLESHOOTING',
      'SEE ALSO',
    ];
    let cursor = 0;
    for (const section of sections) {
      const idx = m.indexOf(section, cursor);
      expect(idx, `expected ${section} after position ${cursor}`).toBeGreaterThanOrEqual(0);
      cursor = idx + section.length;
    }
  });

  it('renders every command help lists, from the registry', () => {
    const m = stripAnsi(buildManual());
    const expected = [
      'wallet', 'balance', 'address', 'genesis-address', 'inspect-cost',
      'airdrop', 'transfer', 'dust', 'config', 'cache', 'localnet',
      'serve', 'test', 'dev', 'contract', 'help', 'manual',
    ];
    for (const cmd of expected) {
      expect(m, `missing entry for ${cmd}`).toContain(`▸ ${cmd}`);
    }
  });

  it("ends each command's page with its errors, as help shows them", () => {
    const m = stripAnsi(buildManual());
    const tx = m.split('▸ tx')[1]!.split('▸ ')[0]!;
    expect(tx.indexOf('ERRORS')).toBeGreaterThan(tx.indexOf('EXAMPLES'));
    expect(tx).toContain('  ERRORS\n    NETWORK_ERROR                  4  Indexer/node/proof-server connection refused or DNS failure.\n');
    expect(tx).toContain('    Also: the network codes, and INVALID_ARGS, CANCELLED, UNKNOWN, UNSUPPORTED_NODE, NO_STATE_ROOT (mn manual lists them all).\n');
  });

  it('lists each set of codes the commands name, with its codes', () => {
    const codes = stripAnsi(buildManual()).split('Sets of codes')[1]!.split('TROUBLESHOOTING')[0]!;
    expect(codes).toContain('\n    network   AMBIGUOUS_LOCAL_STACKS, BLOCKFROST_PROJECT_ID_REQUIRED, BLOCKFROST_PROJECT_ID_REJECTED, BLOCKFROST_LIMIT_REACHED, ENDPOINT_SHUT_DOWN\n');
    expect(codes).toContain('\n    chain     UNSUPPORTED_LEDGER, LOCAL_STACK_UNREACHABLE\n');
    expect(codes).toContain('\n    contract  CONTRACT_NOT_COMPILED, CONTRACT_INFO_INVALID, NO_NODE_RUNTIME\n');
  });

  it('lists the stable error code strings', () => {
    const m = stripAnsi(buildManual());
    for (const code of [
      'DUST_REQUIRED', 'STALE_UTXO', 'PROOF_TIMEOUT', 'PROOF_FAILURE',
      'INVALID_DUST_PROOF', 'STALE_CACHE', 'SYNC_TIMEOUT',
    ]) {
      expect(m).toContain(code);
    }
  });

  it('documents the network-id config alias', () => {
    const m = stripAnsi(buildManual());
    expect(m).toContain('network-id');
  });

  it('documents exit codes 0 through 7', () => {
    const m = stripAnsi(buildManual());
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(m, `expected exit code ${n}`).toContain(`  ${n}  `);
    }
  });

  it('mentions "mn manual" in the SEE ALSO section indirectly via help/agent pointers', () => {
    const m = stripAnsi(buildManual());
    expect(m).toContain('mn help --agent');
    expect(m).toContain('mn help <command>');
  });

  it('produces non-trivial length (at least 200 lines)', () => {
    const m = stripAnsi(buildManual());
    expect(m.split('\n').length).toBeGreaterThanOrEqual(200);
  });

  it('describes every key `config` accepts', () => {
    // The keys config accepts, as its refusal of an unknown key lists them.
    let refusal = '';
    const root = mkdtempSync(join(tmpdir(), 'mn-manual-'));
    try { getConfigValue('no-such-key', root); } catch (err) { refusal = (err as Error).message; } finally { rmSync(root, { recursive: true, force: true }); }
    const keys = refusal.split('Valid keys: ')[1]!.split(', ');
    expect(keys.length).toBeGreaterThan(0);
    const section = stripAnsi(buildManual()).split('Config keys')[1]!.split('Compatibility alias')[0]!;
    for (const key of keys) expect(section, key).toMatch(new RegExp(`^ {4}${key}\\b`, 'm'));
  });
});

describe('help --json global flags', () => {
  it('describes every flag the shell accepts on every command', () => {
    const described = installedCommands.globalFlagsHelp.map((flag) => flag.name).join(' ');
    for (const flag of installedCommands.globalFlags) {
      expect(described, flag.name).toContain(flag.name.length === 1 ? `-${flag.name}` : `--${flag.name}`);
    }
  });
});

describe('mn manual --json', () => {
  it('holds the manual as plain text, no ANSI escape codes, even where colour is on', async () => {
    const { default: manualCommand } = await import('../commands/manual.ts');
    const { parseArgs } = await import('@kuiralabs/midnight-cli-core');
    const { captureOutput } = await import('../../test-support/capture-output.ts');
    const { cliCall } = await import('./helpers/cli-call.ts');
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = '1';
    const io = captureOutput();
    try {
      await cliCall(manualCommand, parseArgs(['manual', '--json']));
    } finally {
      io.restore();
      if (saved === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = saved;
    }
    const { manual } = JSON.parse(io.stdout()) as { manual: string };
    expect(manual).toContain('EXIT CODES');
    expect(manual).not.toMatch(/\x1b\[/);
  });
});
