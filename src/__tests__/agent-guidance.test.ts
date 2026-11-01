// Agent guidance per package (plan 2G, D19): each package is installed with its
// pieces of the agent manual and the two skills, and the shell and the MCP
// server assemble them. What the texts say is pinned by the behaviour snapshot
// and by the docs/ copies (skill-docs.test.ts); these tests check the
// assembly, the registry's checks, where each package's guidance lives, and
// what changes when a package is not installed.

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { installedCommands } from '../lib/installed-commands.ts';
import {
  CommandDefinitionError,
  createPackageRegistry,
  type CommandDefinition,
  type CommandPackage,
  type CommandRegistry,
} from '../lib/command-definition.ts';
import { GuidanceError, assembleGuidance, type GuidancePiece, type GuidanceText } from '../lib/agent-guidance.ts';
import { AGENT_MANUAL_SECTIONS, TOOL_GROUPS, agentManual } from '../lib/agent-manual.ts';
import { SKILL_CORE_SECTIONS, SKILL_FULL_SECTIONS, skillCore, skillFull } from '../lib/mcp/skills.ts';
import { listedTools } from '../lib/mcp/registry-tools.ts';
import { guidanceRule, homeOf } from '../../scripts/check-layering.mjs';

const SRC = join(import.meta.dirname, '..');

const SECTIONS: Record<GuidanceText, readonly string[]> = {
  'agent-manual': AGENT_MANUAL_SECTIONS,
  'skill-core': SKILL_CORE_SECTIONS,
  'skill-full': SKILL_FULL_SECTIONS,
};

/** The installed packages but one, as the shell would install them without it. */
function withoutPackage(name: string): CommandRegistry {
  const packages = installedCommands.packages.filter((pkg) => pkg.name !== name);
  const gone = new Set(installedCommands.packages.find((pkg) => pkg.name === name)!.commands.map((c) => c.name));
  const order = installedCommands.commands.map((c) => c.name).filter((n) => !gone.has(n));
  return createPackageRegistry(packages, order, installedCommands.globalFlags, installedCommands.globalFlagsHelp);
}

/** The manual's AVAILABLE MCP TOOLS section, up to the next one. */
function toolsSection(manual: string): string {
  return manual.split('AVAILABLE MCP TOOLS')[1]!.split('TOOL ANNOTATIONS')[0]!;
}

const piece = (section: string, order: number, body: string, text: GuidanceText = 'skill-core'): GuidancePiece => ({ text, section, order, body });

describe('assembleGuidance', () => {
  it('reads each section\'s pieces in their order, in the skeleton\'s order, leaving other texts\' pieces out', () => {
    const text = assembleGuidance('skill-core', ['a', 'b'], [
      piece('b', 20, 'b2 '), piece('a', 10, 'a1 '), piece('b', 5, 'b1 '), piece('a', 10, 'other text', 'skill-full'),
    ]);
    expect(text).toBe('a1 b1 b2 ');
  });

  it('refuses a piece whose section its text lacks', () => {
    expect(() => assembleGuidance('skill-core', ['a'], [piece('a', 1, 'x'), piece('nope', 1, 'y')])).toThrow(GuidanceError);
    expect(() => assembleGuidance('skill-core', ['a'], [piece('nope', 1, 'y')])).toThrow(/"nope"/);
  });

  it('refuses two pieces in one place of a section', () => {
    expect(() => assembleGuidance('skill-core', ['a'], [piece('a', 1, 'x'), piece('a', 1, 'y')])).toThrow(/place 1 in section "a"/);
  });
});

describe('createPackageRegistry', () => {
  const command = (name: string, tools: string[] = []): CommandDefinition => ({
    name,
    flags: [],
    needsWalletSdk: false,
    shell: {},
    load: async () => ({ default: async () => {} }),
    mcp: { tools: tools.map((tool, i) => ({ name: tool, description: tool, params: [], argv: { flags: [] }, order: name.length * 100 + i })) },
  });
  const pkg = (name: string, commands: CommandDefinition[], guidance: CommandPackage['guidance'] = { pieces: [] }): CommandPackage => ({ name, commands, guidance });

  it('lists commands in help\'s order, then the ones it doesn\'t name in their package\'s order, and keeps the packages', () => {
    const packages = [pkg('p', [command('a'), command('b')]), pkg('plugin', [command('zz'), command('yy')])];
    const registry = createPackageRegistry(packages, ['b', 'a'], []);
    expect(registry.commands.map((c) => c.name)).toStrictEqual(['b', 'a', 'zz', 'yy']);
    expect(registry.packages).toBe(packages);
  });

  it('refuses a command in two packages, a package twice, and a help order naming a command no package installs', () => {
    expect(() => createPackageRegistry([pkg('p', [command('a')]), pkg('q', [command('a')])], [], [])).toThrow(/command "a"/);
    expect(() => createPackageRegistry([pkg('p', [command('a')]), pkg('p', [command('b')])], [], [])).toThrow(/package "p"/);
    expect(() => createPackageRegistry([pkg('p', [command('a')])], ['a', 'gone'], [])).toThrow(/"gone"/);
  });

  it('refuses two packages\' pieces in one place', () => {
    const p = pkg('p', [command('a')], { pieces: [piece('s', 10, 'x')] });
    const q = pkg('q', [command('b')], { pieces: [piece('s', 10, 'y')] });
    expect(() => createPackageRegistry([p, q], [], [])).toThrow(CommandDefinitionError);
  });

  it('refuses a tools table row for another package\'s tool, a tool given two rows, and two rows in one place', () => {
    const row = (tool: string, order = 1) => ({ tool, group: 'g', order, description: ['d'] });
    const tooled = command('a', ['t_a']);
    expect(() => createPackageRegistry([pkg('p', [tooled]), pkg('q', [command('bb')], { pieces: [], toolsTable: [row('t_a')] })], [], []))
      .toThrow(/q: its tools table has a row for t_a/);
    expect(() => createPackageRegistry([pkg('p', [tooled], { pieces: [], toolsTable: [row('t_a', 1), row('t_a', 2)] })], [], [])).toThrow(/t_a/);
    expect(() => createPackageRegistry([pkg('p', [command('a', ['t_a', 't_b'])], { pieces: [], toolsTable: [row('t_a'), row('t_b')] })], [], []))
      .toThrow(/tools table place/);
  });
});

describe('the installed packages\' guidance', () => {
  it('names, in every piece, a section its text has', () => {
    const unplaced = installedCommands.packages.flatMap((pkg) => pkg.guidance.pieces
      .filter((p) => !SECTIONS[p.text].includes(p.section))
      .map((p) => `${pkg.name}: ${p.text} ${p.section}`));
    expect(unplaced).toStrictEqual([]);
  });

  it('puts every tools table row in a group the manual has, and gives every tool a row', () => {
    const rows = installedCommands.packages.flatMap((pkg) => pkg.guidance.toolsTable ?? []);
    expect(rows.filter((row) => !TOOL_GROUPS.some((group) => group.id === row.group))).toStrictEqual([]);
    expect(installedCommands.tools.map((tool) => tool.name).filter((name) => !rows.some((row) => row.tool === name))).toStrictEqual([]);
  });

  it('lives in one file beside its package\'s commands, which the layering check places in that package', () => {
    for (const pkg of installedCommands.packages.filter((p) => p.name !== 'shell')) {
      expect(homeOf(join(SRC, 'commands', `${pkg.name}.guidance.ts`))).toBe(pkg.name);
      for (const command of pkg.commands) expect([command.name, homeOf(join(SRC, 'commands', `${command.name}.definition.ts`))]).toStrictEqual([command.name, pkg.name]);
    }
  });

  it('may import core, and no package may import another\'s guidance (the layering rule)', () => {
    expect(guidanceRule('commands/wallet.guidance.ts', 'lib/agent-guidance.ts')).toBeUndefined();
    expect(guidanceRule('commands/grant.guidance.ts', 'commands/wallet.guidance.ts')).toBe('grant guidance → wallet');
    expect(guidanceRule('commands/grant.guidance.ts', 'lib/facade.ts')).toBe('grant guidance → wallet');
    expect(guidanceRule('lib/grant/prepare.ts', 'commands/wallet.guidance.ts')).toBe('grant → wallet guidance');
    // The shell assembles every package's guidance.
    expect(guidanceRule('lib/installed-commands.ts', 'commands/grant.guidance.ts')).toBeUndefined();
  });
});

describe('the texts, assembled from the installed packages', () => {
  it('lists every tool the MCP server lists in the manual\'s tools table, and counts them', () => {
    const section = toolsSection(agentManual(installedCommands));
    const listed = listedTools(installedCommands).map((tool) => tool.name);
    const shown = [...section.matchAll(/^ {2}(midnight_\w+)/gm)].map((m) => m[1]);
    expect([...shown].sort()).toStrictEqual([...listed].sort());
    expect(section.startsWith(` (${listed.length})\n`)).toBe(true);
    expect(listed.length).toBe(38);
  });

  it('lists the grant tools under Grants (experimental), last', () => {
    const section = toolsSection(agentManual(installedCommands));
    const grants = section.split('  Grants (experimental)\n')[1]!.split('\n\n')[0]!;
    expect([...grants.matchAll(/^ {2}(midnight_\w+)/gm)].map((m) => m[1])).toStrictEqual([
      'midnight_grant_status', 'midnight_grant_list', 'midnight_grant_request', 'midnight_grant_deploy',
      'midnight_grant_deposit', 'midnight_grant_issue', 'midnight_grant_revoke', 'midnight_grant_revoke_all',
    ]);
  });

  it('shows a tool no package gives a row for under Other, with its own description, so the count stays right', () => {
    const packages = installedCommands.packages.map((pkg) => (pkg.name === 'grant' ? { ...pkg, guidance: { pieces: pkg.guidance.pieces } } : pkg));
    const registry = createPackageRegistry(packages, installedCommands.commands.map((c) => c.name), installedCommands.globalFlags, installedCommands.globalFlagsHelp);
    const section = toolsSection(agentManual(registry));
    expect(section).not.toContain('Grants (experimental)');
    expect(section).toContain('  Other\n  midnight_grant_status        The wallet\'s account: address, owner key, what it holds, number of grants (see skill).');
    expect(section.startsWith(' (38)\n')).toBe(true);
  });

  it('leaves out a package that is not installed: its sections, its rows and its tools', () => {
    const registry = withoutPackage('grant');
    const manual = agentManual(registry);
    expect(manual).not.toContain('GRANTS (experimental)');
    expect(manual).not.toContain('NO_ACCOUNT');
    expect(manual).not.toContain('midnight_grant_');
    expect(toolsSection(manual).startsWith(' (30)\n')).toBe(true);
    expect(skillCore(registry)).not.toContain('midnight_grant_');
    const full = skillFull(registry);
    expect(full).not.toContain('allowance (experimental)');
    expect(full).not.toContain('`NO_ACCOUNT`');
    // The passphrase paragraph keeps its own part and its paragraph break.
    expect(full).toContain('which encrypts every wallet and account in one step.\n\n### Preprod needs a Blockfrost project id');
  });

  it('keeps a shared section\'s other packages in order when one is missing', () => {
    const manual = agentManual(withoutPackage('dev'));
    const codes = manual.split('ERROR CODES')[1]!.split('MCP SERVER')[0]!;
    expect(codes).not.toContain('LOCALNET_UNAVAILABLE');
    expect(codes).toContain('UNSUPPORTED_LEDGER      4     The chain is on ledger 8; use mn 0.5.x for it\n  LOCAL_STACK_UNREACHABLE 4');
    expect(manual).not.toContain('E2E TESTING');
  });
});
