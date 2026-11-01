// docs/SKILL-CORE.md and docs/SKILL.md are generated copies of the skills the
// MCP server assembles from the installed packages (plan 2G, decision 2): they
// stay in the repository for the README's links and the npm package. When one
// differs from the assembly, run `npm run skill-docs`. The server itself is run
// as a real process with a temporary home, to show it serves the assembly.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installedCommands } from '../lib/installed-commands.ts';
import { SKILL_DOCS, skillCore, skillFull } from '../lib/mcp/skills.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

describe('the docs/ copies of the skills', () => {
  it.each(SKILL_DOCS.map((doc) => [doc.path, doc]))('%s is the assembly, byte for byte (npm run skill-docs writes it)', (_, { path: file, assemble }) => {
    expect(fs.readFileSync(path.join(REPO, file), 'utf8')).toBe(assemble(installedCommands));
  });

  it('are the two files npm ships', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { files: string[] };
    expect(SKILL_DOCS.map((doc) => doc.path).every((file) => pkg.files.includes(file))).toBe(true);
  });
});

describe('the MCP server\'s skill resources', () => {
  let home: string;
  let client: Client;

  beforeAll(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-mcp-skills-home-')));
    const env = { ...process.env, HOME: home, NO_COLOR: '1' } as Record<string, string>;
    client = new Client({ name: 'mn-test', version: '0' });
    await client.connect(new StdioClientTransport({ command: TSX, args: [path.join(REPO, 'src', 'mcp-server.ts')], env, stderr: 'ignore' }));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const read = async (uri: string) => ((await client.readResource({ uri })).contents[0] as { text: string }).text;

  it('serves skill/core, skill/full and the legacy skill URI as assembled from the installed packages', async () => {
    expect(await read('midnight-wallet://skill/core')).toBe(skillCore(installedCommands));
    expect(await read('midnight-wallet://skill/full')).toBe(skillFull(installedCommands));
    expect(await read('midnight-wallet://skill')).toBe(skillFull(installedCommands));
  }, 60_000);
});
