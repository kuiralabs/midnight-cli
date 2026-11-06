// Writes the generated tables of the README and docs/JSON_CONTRACT.md between
// their markers: the README's table of commands, from the installed commands'
// definitions, and the contract's table of error codes, from the installed
// packages' code definitions. A test fails when either file differs.
//
// Usage: npm run readme-commands

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedCommands } from '../src/lib/installed-commands.ts';
import { readmeCommandTable, withReadmeCommandTable } from '../src/lib/readme-commands.ts';
import { jsonContractCodeTable, withJsonContractCodeTable } from '../src/lib/code-tables.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');
const JSON_CONTRACT = join(ROOT, 'docs', 'JSON_CONTRACT.md');

writeFileSync(README, withReadmeCommandTable(readFileSync(README, 'utf8'), readmeCommandTable(installedCommands)));
process.stdout.write('wrote README.md\n');
writeFileSync(JSON_CONTRACT, withJsonContractCodeTable(readFileSync(JSON_CONTRACT, 'utf8'), jsonContractCodeTable(installedCommands)));
process.stdout.write('wrote docs/JSON_CONTRACT.md\n');
