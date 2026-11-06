// The code tables are generated from the installed packages' code
// definitions: `help --agent`'s ERROR CODES, the full skill's error recovery
// recipes, `mn manual`'s EXIT CODES block and docs/JSON_CONTRACT.md's table.
// Each has one row for every registered code, in the codes' order, with its
// exit code, and no row for a code no package defines.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeGuidancePieces, GuidanceError, manualCodeRow, skillCodeRow, wrapWords, type CodeDefinition } from '@kuiralabs/midnight-cli-core';
import { installedCommands } from '../lib/installed-commands.ts';
import { agentManual } from '../lib/agent-manual.ts';
import { skillFull } from '../lib/mcp/skills.ts';
import { buildManual } from '../commands/manual.ts';
import { JSON_CONTRACT_CODES_END, JSON_CONTRACT_CODES_START, installedCodes, jsonContractCodeTable, withJsonContractCodeTable } from '../lib/code-tables.ts';

const JSON_CONTRACT = join(fileURLToPath(new URL('../..', import.meta.url)), 'docs', 'JSON_CONTRACT.md');

/** The text between `from` and the next `to` in `text`. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start + from.length, end);
}

/** Each row's code and exit code, as `pattern` (with the code and the exit code as its groups) finds them. */
function rowsOf(table: string, pattern: RegExp): Array<[string, number]> {
  return [...table.matchAll(pattern)].map((match) => [match[1]!, Number(match[2])]);
}

const registered = installedCodes(installedCommands);
const expected: Array<[string, number]> = registered.map(({ code, exitCode }) => [code, exitCode]);

describe('the code tables', () => {
  it('know the codes every installed package defines, each with its order and recovery', () => {
    expect(registered.length).toBeGreaterThan(30);
    for (const definition of registered) {
      expect(definition.order, definition.code).toBeTypeOf('number');
      expect(definition.recovery, definition.code).toBeTypeOf('string');
    }
    expect(new Set(registered.map((definition) => definition.order)).size).toBe(registered.length);
  });

  it("help --agent's ERROR CODES: a row for every registered code and no other", () => {
    const table = between(agentManual(installedCommands), 'ERROR CODES', 'MCP SERVER');
    // A code too long for its column has its exit code beside it and its meaning on the next line.
    expect(rowsOf(table, /^ {2}([A-Z][A-Z0-9_]+) +(\d)\b/gm)).toStrictEqual(expected);
  });

  it("the full skill's error recovery recipes: a row for every registered code and no other", () => {
    const table = between(skillFull(installedCommands), '## Error recovery recipes', '\n## ');
    const rows = [...table.matchAll(/^\| `([A-Z0-9_]+)` \| (.*) \| (.*) \|$/gm)];
    expect(rows.map((row) => row[1])).toStrictEqual(registered.map(({ code }) => code));
    for (const [, code, summary, recovery] of rows) {
      const definition = registered.find((d) => d.code === code)!;
      expect([summary, recovery]).toStrictEqual([definition.summary, definition.recovery]);
    }
  });

  it("mn manual's EXIT CODES: a line for every registered code and no other", () => {
    // Without its colours.
    const manual = buildManual().replace(/\x1b\[[0-9;]*m/g, '');
    const block = between(manual, 'EXIT CODES', 'TROUBLESHOOTING');
    expect(rowsOf(block, /^ {4}([A-Z][A-Z0-9_]+) +(\d) {2}/gm)).toStrictEqual(expected);
  });

  it("docs/JSON_CONTRACT.md's table: the generated one, byte for byte (npm run readme-commands writes it)", () => {
    const doc = readFileSync(JSON_CONTRACT, 'utf8');
    expect(doc).toBe(withJsonContractCodeTable(doc, jsonContractCodeTable(installedCommands)));
    expect(rowsOf(between(doc, JSON_CONTRACT_CODES_START, JSON_CONTRACT_CODES_END), /^\| `([A-Z0-9_]+)` \| (\d) \|/gm)).toStrictEqual(expected);
  });
});

describe('a code row', () => {
  const ORACLE: CodeDefinition = { code: 'PLUGIN_ORACLE_DOWN', exitCode: 4, order: 500, summary: "The plugin's price oracle did not answer within the time it is given, which a busy oracle can take.", recovery: 'Retry later | or not.' };

  it('wraps the meaning at 48 characters from column 32', () => {
    expect(manualCodeRow(ORACLE)).toBe(
      '  PLUGIN_ORACLE_DOWN      4     The plugin\'s price oracle did not answer within\n'
      + '                                the time it is given, which a busy oracle can\n'
      + '                                take.\n');
    expect(wrapWords('a b  c', 3)).toStrictEqual(['a b', 'c']);
  });

  it('puts the exit code beside a long code and the meaning under it', () => {
    expect(manualCodeRow({ ...ORACLE, code: 'PLUGIN_PRICE_ORACLE_UNREACHABLE', summary: 'No answer.' }))
      .toBe('  PLUGIN_PRICE_ORACLE_UNREACHABLE 4\n                                No answer.\n');
    expect(manualCodeRow({ ...ORACLE, code: 'PLUGIN_ORACLE_UNREACHABLE', summary: 'No answer.' }))
      .toBe('  PLUGIN_ORACLE_UNREACHABLE 4   No answer.\n');
  });

  it("is the skill's recipe, a pipe escaped", () => {
    expect(skillCodeRow(ORACLE)).toBe("| `PLUGIN_ORACLE_DOWN` | The plugin's price oracle did not answer within the time it is given, which a busy oracle can take. | Retry later \\| or not. |\n");
  });

  it('is placed by its order in both texts, and refused without an order or a recovery', () => {
    expect(codeGuidancePieces([ORACLE]).map(({ text, section, order }) => [text, section, order])).toStrictEqual([['agent-manual', 'error-codes', 500], ['skill-full', 'error-recovery', 500]]);
    expect(() => codeGuidancePieces([{ ...ORACLE, order: undefined }])).toThrow(GuidanceError);
    expect(() => codeGuidancePieces([{ ...ORACLE, recovery: undefined }])).toThrow(/no recovery/);
  });
});
