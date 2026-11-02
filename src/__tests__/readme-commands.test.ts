// The README's table of commands is generated from the command registry, so
// a command can't be missing from it (grant was). When it differs, run
// `npm run readme-commands`.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedCommands } from '../lib/installed-commands.ts';
import { README_COMMANDS_END, README_COMMANDS_START, readmeCommandTable, withReadmeCommandTable } from '../lib/readme-commands.ts';

const README = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'README.md');

describe("the README's table of commands", () => {
  it('is the generated table, byte for byte (npm run readme-commands writes it)', () => {
    const readme = fs.readFileSync(README, 'utf8');
    expect(readme).toBe(withReadmeCommandTable(readme, readmeCommandTable(installedCommands)));
  });

  it('has a row for every command help lists, grant among them', () => {
    const table = readmeCommandTable(installedCommands);
    const listed = installedCommands.commands.filter((command) => command.help !== undefined);
    expect(table.trimEnd().split('\n')).toHaveLength(listed.length + 2);
    expect(table).toContain('| `midnight grant <deploy\\|deposit\\|status');
  });

  it('escapes a pipe so it stays in its cell', () => {
    const table = readmeCommandTable({ commands: [{ ...installedCommands.find('config')!, help: { description: 'a | b', usage: 'midnight x <p|q>' } }] });
    expect(table).toBe('| Command | Description |\n|---------|-------------|\n| `midnight x <p\\|q>` | a \\| b |\n');
  });

  it('refuses a README without the markers', () => {
    expect(() => withReadmeCommandTable('# no markers\n', '')).toThrow(README_COMMANDS_START);
    expect(withReadmeCommandTable(`a\n${README_COMMANDS_START}\nold\n${README_COMMANDS_END}\nb`, 'new\n')).toBe(`a\n${README_COMMANDS_START}\nnew\n${README_COMMANDS_END}\nb`);
  });
});
