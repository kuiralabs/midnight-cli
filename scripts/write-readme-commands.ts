// Writes the README's table of commands from the installed commands'
// definitions, between its markers. A test fails when the README differs.
//
// Usage: npm run readme-commands

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedCommands } from '../src/lib/installed-commands.ts';
import { readmeCommandTable, withReadmeCommandTable } from '../src/lib/readme-commands.ts';

const README = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'README.md');

writeFileSync(README, withReadmeCommandTable(readFileSync(README, 'utf8'), readmeCommandTable(installedCommands)));
process.stdout.write('wrote README.md\n');
