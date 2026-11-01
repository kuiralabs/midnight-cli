// Writes docs/SKILL-CORE.md and docs/SKILL.md from the installed packages'
// guidance, as the MCP server assembles skill/core and skill/full (plan 2G).
// The copies stay in the repository for the README's links and the npm
// package; a test fails when they differ from the assembly.
//
// Usage: npm run skill-docs

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedCommands } from '../src/lib/installed-commands.ts';
import { SKILL_DOCS } from '../src/lib/mcp/skills.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const { path, assemble } of SKILL_DOCS) {
  writeFileSync(join(ROOT, path), assemble(installedCommands));
  process.stdout.write(`wrote ${path}\n`);
}
