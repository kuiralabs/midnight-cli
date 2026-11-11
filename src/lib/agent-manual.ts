// The `help --agent` manual: the shell's skeleton of sections
// and its own text (the overview, networks, JSON conventions, the MCP server's
// setup, its tools table and resources), with each installed package's pieces
// placed in the sections they name. The tools table is generated from the
// registry's tools, each in the topic group its package's row names.

import { PKG_VERSION } from './pkg.ts';
import { codeSetLines } from './code-tables.ts';
import { GuidanceError, PROOF_SERVER_DOCKER_RUN, assembleGuidance, sectionsWithAdded, type GuidancePiece, type ToolsTableRow, commandHelpSpecs, type CommandRegistry, type RegisteredTool } from '@kuiralabs/midnight-cli-core';

/** The manual's sections, in order. */
export const AGENT_MANUAL_SECTIONS = [
  'overview',
  'json-schemas',
  'shielded-transactions',
  'wallet-name-resolution',
  'dapp-connector',
  'smart-contracts',
  'grants',
  'e2e-testing',
  'error-codes',
  'mcp-server',
  'mcp-tools',
  'tool-annotations',
  'two-step-confirmation',
  'mcp-resources',
  'typical-workflows',
  'example-commands',
] as const;

/**
 * The tools table's topic groups, in order. `width` is the description
 * column's, as the old hand-written table aligned each group.
 */
export const TOOL_GROUPS: readonly { readonly id: string; readonly title: string; readonly width: number }[] = [
  { id: 'wallet-management', title: 'Wallet Management', width: 53 },
  { id: 'balance-info', title: 'Balance & Info', width: 53 },
  { id: 'transactions', title: 'Transactions', width: 53 },
  { id: 'consent', title: 'Consent', width: 53 },
  { id: 'configuration', title: 'Configuration', width: 53 },
  { id: 'local-network', title: 'Local Network', width: 53 },
  { id: 'contracts', title: 'Contracts (Compact smart contracts)', width: 52 },
  { id: 'test-framework', title: 'Test Framework', width: 52 },
  { id: 'grants', title: 'Grants (experimental)', width: 53 },
  { id: 'swaps', title: 'Swaps (experimental)', width: 53 },
];

/** Where a tool no package gives a row for is listed, with its own description. */
const OTHER_GROUP = { id: 'other', title: 'Other', width: 53 };

/** The MCP server's own tool, which no command defines. */
const CONFIRM_ROW: ToolsTableRow = {
  tool: 'midnight_confirm_operation',
  group: 'consent',
  order: 10,
  description: ['Redeem a pending token returned by a destructive', 'tool (step 2 of the confirmation flow)'],
  params: ['token'],
};

const NAME_WIDTH = 29;

function overview(): GuidancePiece {
  return {
    text: 'agent-manual',
    section: 'overview',
    order: 0,
    body: `
MIDNIGHT CLI — AI Agent & MCP Reference
========================================

Version: ${PKG_VERSION}

OVERVIEW
────────

midnight-wallet-cli (mn) is a standalone CLI wallet for the Midnight
blockchain. It manages wallets, balances, transfers (unshielded and
shielded), dust fees, a DApp connector server, contract inspection,
E2E testing, and a local devnet — all from the terminal.

Wallets are network-agnostic: one seed derives addresses for all four
networks (undeployed, preprod, preview, mainnet). Network is chosen
at runtime.

Mainnet moves real value. mn reaches it only when a call names it
(--network mainnet, or a tool's network parameter): it can't be the saved
network, and a call without a network never reaches it. It is served only by
Blockfrost, with the user's mainnet project id (it starts with nightmainnet).
No faucet: airdrop, mn test and mn grant are refused there with
MAINNET_REFUSED. Its addresses have no network segment (mn_addr1...).

Preprod's and mainnet's indexers and nodes are served by Blockfrost (Midnight
shut its own down on 2026-10-09). Every request needs the user's own project
id, one per network (preprod's start with nightpreprod, mainnet's with
nightmainnet), from a Midnight project at https://blockfrost.io:
  midnight config set blockfrost-project-id <project id>
or MN_BLOCKFROST_PROJECT_ID (or BLOCKFROST_PROJECT_ID) in the environment.
Without one, a command that
reaches preprod or mainnet fails with BLOCKFROST_PROJECT_ID_REQUIRED. The project id is
a secret: mn never prints it. Preview and undeployed need none.

LEDGER 9: mn speaks ledger 9, which mainnet, preprod and preview all run.
localnet up starts a ledger-9 stack on undeployed. A local stack still on
ledger 8 is refused up front (UNSUPPORTED_LEDGER): restart or upgrade it.

PROOF SERVER: mn proves every transaction with a proof server on the user's
machine, on every network (default http://localhost:6300). On undeployed,
localnet up starts one. On preview, preprod and mainnet the user runs one:
  ${PROOF_SERVER_DOCKER_RUN}
or points mn at theirs: midnight config set proof-server <url>. Without
one, a write fails with NETWORK_ERROR naming the proof server.

STRUCTURED JSON OUTPUT
──────────────────────

Every command supports --json. When passed:
  - stdout receives a single line of JSON
  - stderr stays quiet (no spinners, headings or notices), except for
    the plain progress lines of a long wait, such as a deploy waiting for
    its wallet's Dust ("Dust: waited 45 s of 104 s, 0.76 of 1.23 DUST")
  - Errors: {"error":true,"code":"...","message":"...","exitCode":N}
  - "warnings": the notices the command would print on stderr without
    --json (a hosted Dust read done in WASM, a store moved, ...), one
    string each, in the order given; present only when there are some.
    MCP tool results carry it too

Usage: midnight <command> [args] --json

CAPABILITY MANIFEST
───────────────────

  midnight help --json

Outputs a machine-readable manifest with all commands, flags,
examples, and JSON field schemas.

`,
  };
}

/** Each command's usage, its own error codes and the sets of codes it declares, and the fields of its --json output, from the registry. */
function jsonSchemas(registry: CommandRegistry): GuidancePiece {
  const schemas = commandHelpSpecs(registry).filter((spec) => spec.jsonFields).map((spec) => {
    const fields = Object.entries(spec.jsonFields!)
      .map(([k, v]) => `    ${k.padEnd(20)}${v}`)
      .join('\n');
    return `
  ${spec.name}
  ${spec.usage}
  Error codes: ${spec.ownCodes.map((definition) => definition.code).join(', ') || 'none'}; sets: ${spec.errorSets.join(', ') || 'none'}
  JSON fields:
${fields}`;
  }).join('\n');
  return { text: 'agent-manual', section: 'json-schemas', order: 0, body: `COMMANDS & JSON SCHEMAS\n───────────────────────\n${schemas}\n\n` };
}

/** A row's lines: the tool's name, then its description and parameters side by side. */
function rowLines(row: ToolsTableRow, width: number, tool: RegisteredTool | undefined): string[] {
  const params = row.params ?? [tool?.required?.length ? tool.required.join(', ') : '—'];
  return Array.from({ length: Math.max(row.description.length, params.length) }, (_, i) => {
    const name = (i === 0 ? row.tool : '').padEnd(NAME_WIDTH);
    const description = row.description[i] ?? '';
    return params[i] === undefined ? `  ${name}${description}` : `  ${name}${description.padEnd(width)}${params[i]}`;
  });
}

/**
 * The AVAILABLE MCP TOOLS section: every tool the registry has and the
 * server's confirm tool, by topic group, each group's rows in their order.
 */
function mcpTools(registry: CommandRegistry): GuidancePiece {
  const given = new Map(registry.packages.flatMap((pkg) => pkg.guidance.toolsTable ?? []).map((row) => [row.tool, row]));
  const rows: ToolsTableRow[] = [CONFIRM_ROW, ...registry.tools.map((tool, i) =>
    given.get(tool.name) ?? { tool: tool.name, group: OTHER_GROUP.id, order: i, description: [tool.description] })];
  const groups = [...TOOL_GROUPS, OTHER_GROUP];
  for (const row of rows) {
    if (!groups.some((group) => group.id === row.group)) throw new GuidanceError(`${row.tool}'s row names tools table group "${row.group}", which the manual lacks`);
  }
  const tools = new Map(registry.tools.map((tool) => [tool.name, tool]));
  const shown = groups.flatMap((group) => {
    const own = rows.filter((row) => row.group === group.id).sort((a, b) => a.order - b.order);
    if (own.length === 0) return [];
    return [`  ${group.title}\n${own.flatMap((row) => rowLines(row, group.width, tools.get(row.tool))).map((line) => `${line}\n`).join('')}`];
  });
  const heading = `AVAILABLE MCP TOOLS (${rows.length})`;
  const body = `${heading}\n${'─'.repeat(heading.length)}\n\n${shown.join('\n')}
Optional params shared by wallet tools: wallet, network.
All tools return JSON. Every response carries _serverVersion so a stale
MCP server (CLI on disk says X, responses still say Y) is detectable.
Errors: {error, code, message, _serverVersion}.

`;
  return { text: 'agent-manual', section: 'mcp-tools', order: 0, body };
}

/** The shell's own text that reads the same whatever is installed. */
const SHELL_PIECES: readonly GuidancePiece[] = [
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 0,
      body: `ERROR CODES
───────────

  Code                    Exit  Meaning
`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 1000,
      body: `
`,
    },
    {
      text: 'agent-manual',
      section: 'mcp-server',
      order: 0,
      body: `MCP SERVER
──────────

The CLI includes an MCP (Model Context Protocol) server for native
AI agent integration. Agents call typed tools directly via JSON-RPC
over stdio — no shell spawning or output parsing.

Setup:

  Claude Code (.mcp.json):
  { "mcpServers": { "midnight-wallet": { "command": "midnight-wallet-mcp" } } }

  CLI: claude mcp add --transport stdio midnight-wallet -- midnight-wallet-mcp

  Cursor (.cursor/mcp.json):
  { "mcpServers": { "midnight-wallet": { "command": "midnight-wallet-mcp" } } }

  VS Code (.vscode/mcp.json):
  { "servers": { "midnight-wallet": { "type": "stdio", "command": "midnight-wallet-mcp" } } }

If not installed globally, use "command": "npx" with
"args": ["-y", "midnight-wallet-cli@latest", "--mcp"].

`,
    },
    {
      text: 'agent-manual',
      section: 'tool-annotations',
      order: 0,
      body: `TOOL ANNOTATIONS (MCP safety hints)
───────────────────────────────────

Every tool carries MCP-spec annotations so clients can apply safety policy
without hardcoding per-tool rules:

  readOnlyHint      Safe to call without user consent (balance, info, list).
  destructiveHint   Moves funds, deletes files, or tears down infra — treat
                    as requiring user consent.
  idempotentHint    Repeated calls with same args yield the same result.
  openWorldHint     Touches the network / chain / Docker — can fail
                    non-deterministically.

`,
    },
    {
      text: 'agent-manual',
      section: 'two-step-confirmation',
      order: 0,
      body: `TWO-STEP CONFIRMATION FLOW
──────────────────────────

midnight_transfer does NOT execute on the first call. It returns a pending
token that the agent must show to the user for consent, then redeem via
midnight_confirm_operation to actually execute.

  Call 1:  midnight_transfer({ to, amount, wallet, network })
           or, several recipients in one transaction:
           midnight_transfer({ recipients: [{ to, amount }, ...], wallet, network })
           → { pending: true, token, description, expiresAt, nextStep }
  Show:    the description to the user verbatim.
  Call 2:  midnight_confirm_operation({ token })
           → actual transfer result (txHash, etc)

Tokens are single-use and expire after 5 minutes.

`,
    },
    {
      text: 'agent-manual',
      section: 'two-step-confirmation',
      order: 20,
      body: `Every tool that moves funds, changes an account or deletes a seed works
the same way (midnight_wallet_generate only with force: true):

`,
    },
    {
      text: 'agent-manual',
      section: 'mcp-resources',
      order: 0,
      body: `MCP RESOURCES (skill files)
───────────────────────────

The server exposes two MCP Resources — a small core and a fuller guide:

  uri       midnight-wallet://skill/core
  name      midnight-wallet skill (core)
  mimeType  text/markdown
  Read this first. Intent routing table + non-negotiable safety rules
  (about 1.5k tokens, 5.5 KB). Fetch on session start.

  uri       midnight-wallet://skill/full
  name      midnight-wallet skill (full)
  mimeType  text/markdown
  Canonical multi-step flows, error-recovery recipes, concept primers
  (NIGHT/DUST/shielded), network selection (about 10k tokens, 39 KB).
  Fetch on demand — on an error, a multi-step flow, or a concept question.

The bare midnight-wallet://skill URI stays as a deprecated alias for
skill/full so existing clients keep working; it is not advertised in
resources/list. Ground responses in these instead of training-data guesses.

`,
    },
    {
      text: 'agent-manual',
      section: 'typical-workflows',
      order: 0,
      body: `TYPICAL AGENT WORKFLOWS
───────────────────────

`,
    },
    {
      text: 'agent-manual',
      section: 'example-commands',
      order: 0,
      body: `EXAMPLE CLI COMMANDS
────────────────────

`,
    },
];

/** After the code table, each set of codes the commands declare, by the name the commands and the tools' descriptions give it. */
function codeSets(registry: CommandRegistry): GuidancePiece {
  return { text: 'agent-manual', section: 'error-codes', order: 999, body: `\n  Sets of codes (a command's "sets", a tool's "Errors" name them):\n${codeSetLines(registry, 4).map((line) => `${line}\n`).join('')}` };
}

/** The tools behind the two-step confirmation, one per line, from the registry. */
function confirmedTools(registry: CommandRegistry): GuidancePiece {
  const names = registry.tools.filter((tool) => tool.confirmation !== undefined).map((tool) => `  ${tool.name}\n`);
  return { text: 'agent-manual', section: 'two-step-confirmation', order: 30, body: `${names.join('')}\n` };
}

/** The `help --agent` manual for the installed packages. */
export function agentManual(registry: CommandRegistry): string {
  const pieces = [overview(), jsonSchemas(registry), mcpTools(registry), codeSets(registry), confirmedTools(registry), ...SHELL_PIECES, ...registry.packages.flatMap((pkg) => pkg.guidance.pieces)];
  const added = registry.packages.flatMap((pkg) => pkg.guidance.sections ?? []);
  return assembleGuidance('agent-manual', sectionsWithAdded('agent-manual', AGENT_MANUAL_SECTIONS, added), pieces);
}
