// The two skills the MCP server serves: skill/core (intent
// routing and the safety rules) and skill/full (flows, error recovery, concept
// primers). Each is the server's skeleton of sections and its own text (the
// concepts, networks, safety rules and its own setup), with each installed
// package's pieces placed in the sections they name. The server assembles them
// at each resources/read; scripts/write-skill-docs.ts writes the same text to
// docs/SKILL-CORE.md and docs/SKILL.md, the copies the README links to.

import { assembleGuidance, sectionsWithAdded, type GuidancePiece, declaredCodeSets, type CommandRegistry } from '@kuiralabs/midnight-cli-core';

/** skill/core's sections, in order. */
export const SKILL_CORE_SECTIONS = ['title', 'intent-routing', 'safety-rules', 'when-to-fetch'] as const;

/** skill/full's sections, in order. */
export const SKILL_FULL_SECTIONS = [
  'title',
  'what-you-can-do',
  'core-concepts',
  'secrets',
  'blockfrost',
  'intent-routing',
  'canonical-flows',
  'safety-rules',
  'error-recovery',
  'networks',
  'not-this-cli',
  'references',
] as const;

/** The server's own text in both skills. */
const SERVER_PIECES: readonly GuidancePiece[] = [
    {
      text: 'skill-core',
      section: 'title',
      order: 0,
      body: `# midnight-wallet-cli — Agent Skill (Core)

You have access to the \`midnight-wallet-cli\` MCP server. This is the **core** skill — intent routing and non-negotiable safety rules. Fetch \`midnight-wallet://skill/full\` on demand for canonical multi-step flows, error-recovery recipes, concept primers (NIGHT, DUST, shielded vs unshielded), network selection, and deeper context.

**Ledger 9 only.** This build refuses a chain still on ledger 8 (preview and preprod today; those stay on \`midnight-wallet-cli\` 0.5.x). The user runs a ledger-9 stack and points mn at it; details in \`/full\`.

`,
    },
    {
      text: 'skill-core',
      section: 'intent-routing',
      order: 0,
      body: `## Intent routing (natural language → tool)

| User says | Call this tool |
|---|---|
`,
    },
    {
      text: 'skill-core',
      section: 'intent-routing',
      order: 1000,
      body: `
`,
    },
    {
      text: 'skill-core',
      section: 'safety-rules',
      order: 0,
      body: `## Safety rules (non-negotiable)

- **Read tools** (\`readOnlyHint: true\`) — safe to call without user consent.
- **Destructive tools** (\`destructiveHint: true\`) — require explicit user consent before calling.
- **Open-world tools** (\`openWorldHint: true\`) — touch the network/chain/Docker. Can fail non-deterministically; retry is usually safe for reads, risky for writes.
- **Never** auto-execute a fund-moving operation. Always describe amount + recipient + network first.
- **Never** invent a mnemonic, seed, or private key. If the user needs one, call \`midnight_wallet_generate\`.
`,
    },
    {
      text: 'skill-core',
      section: 'when-to-fetch',
      order: 0,
      body: `## When to fetch the full skill

- On any error from a tool call → fetch \`midnight-wallet://skill/full\`, find the recipe in "Error recovery recipes".
- Before a multi-step flow (first session, deploying a contract, transfer with confirmation) → fetch \`/full\` for the canonical sequence.
- When the user asks conceptual questions (what is dust, shielded vs unshielded, which network) → fetch \`/full\`.
- For per-tool details: read the tool description in \`tools/list\`.
- For CLI reference: \`mn help <command>\`.
`,
    },
    {
      text: 'skill-full',
      section: 'title',
      order: 0,
      body: `# midnight-wallet-cli — Agent Skill

You have access to the \`midnight-wallet-cli\` MCP server. This document teaches you how to use it well. Read it once at the start of a session; use it as reference throughout.

> **Ledger 9 only.** This build speaks ledger 9 only. A chain still on ledger 8 (preview and preprod today) is refused up front with an error saying so: tell the user to use \`midnight-wallet-cli\` 0.5.x for it, don't retry. \`midnight_localnet_up()\` starts a ledger-9 stack for \`undeployed\` on the default ports (node 9944, indexer 8088, proof server 6300); another stack is reached by setting its URLs with \`midnight_config_set\` (keys \`node\`, \`indexer-ws\`, \`proof-server\`) or passing \`--node\` / \`--indexer-ws\` / \`--proof-server\` on the CLI.

`,
    },
    {
      text: 'skill-full',
      section: 'what-you-can-do',
      order: 0,
      body: `## What you can do with this CLI

Act on the user's behalf on Midnight, through what the installed packages bring:

`,
    },
    {
      text: 'skill-full',
      section: 'core-concepts',
      order: 0,
      body: `## Core concepts (teach these accurately)

- **Midnight** — a privacy-first blockchain. Supports both **unshielded** (transparent, like Bitcoin) and **shielded** (ZK-private, like Zcash) transactions in one chain.
- **NIGHT** — the native token. 1 NIGHT = 1,000,000 micro-NIGHT (6 decimals).
- **DUST** — a second token used to pay transaction fees. Not transferable. **Generated passively** by registered NIGHT UTXOs. Every wallet holding NIGHT must register those UTXOs for dust generation before it can send anything. Don't explain dust as "gas" — it's time-phase regenerative, not a fee market.
- **Shielded vs unshielded** — shielded addresses start \`mn_shield-addr_*\`; unshielded start \`mn_addr_*\` (on mainnet, with no network segment: \`mn_shield-addr1…\`, \`mn_addr1…\`). A wallet has one of each per network. Sender controls the privacy: \`mn transfer --shielded\` sends privately.
- **No self-shielding** — a wallet cannot move its own funds from unshielded to shielded. To get shielded NIGHT, receive a shielded transfer from a wallet that already has some (genesis wallet has 250M shielded NIGHT on localnet).
- **Networks**
  - \`undeployed\` — local network (\`midnight_localnet_up()\` starts it). Use this for dev iteration.
  - \`preprod\` — public testnet (ledger 8 today, so refused by this build). Its indexer and node are served by Blockfrost and need the user's own project id (see "Preprod and mainnet need a Blockfrost project id" below). First-time wallet sync processes the full event history and can take significantly longer than subsequent syncs (which restore from cached wallet state). Exact time depends on wallet age, event density, network, and hardware.
  - \`preview\` — public preview testnet (ledger 8 today, so refused by this build). Same first-sync trade-off as preprod.
  - \`stagenet\` — Sig Network's testnet, on the beta SDK set (mn loads its beta engine for it). No shielded faucet, so shielded sync is off by default; NIGHT from https://faucet.stagenet.shielded.tools. Its proof server must match its node (\`midnightntwrk/proof-server:9.0.0-rc.5_experimental\`). Grant is refused there for now.
  - \`mainnet\` — Midnight Mainnet: real value. Reached only through Blockfrost with the user's mainnet project id (it starts with \`nightmainnet\`); the proof server is the user's local one. No faucet. Used only when named on each call (\`network: "mainnet"\`, or \`--network mainnet\`): it can't be the saved network, and a call without a network never reaches it. \`midnight_airdrop\`, the test tools and the grant tools are refused there with \`MAINNET_REFUSED\`.
- **Proof server** — local HTTP service that generates ZK proofs for transactions. Default port 6300. Version must match the network's ledger version or writes fail with "Custom error 170".

`,
    },
    {
      text: 'skill-full',
      section: 'secrets',
      order: 0,
      body: `### mn's secrets are encrypted under one passphrase

Every secret mn keeps (each wallet's seed and mnemonic, each account's owner key, records and private state) is encrypted at rest under the user's one passphrase. A tool that needs one (a transfer, a grant command, anything that signs or reads a seed) reads the passphrase from \`MN_PASSPHRASE\` in the MCP server's environment; without it, it fails with \`PASSPHRASE_REQUIRED\` and changes nothing. It is a secret: never ask for it in chat or echo it. Wallets an earlier mn wrote in plain text still work, with a warning, until the user runs \`midnight wallet protect\` in their own terminal, which encrypts every wallet and account in one step.`,
    },
    {
      text: 'skill-full',
      section: 'secrets',
      order: 1000,
      body: `

`,
    },
    {
      text: 'skill-full',
      section: 'blockfrost',
      order: 0,
      body: `### Preprod and mainnet need a Blockfrost project id

Midnight shut its own preprod and mainnet indexers down on 2026-10-09. Blockfrost serves their indexers and nodes now, and every request needs the user's own project id (created at https://blockfrost.io, one project per network; preprod ids start with \`nightpreprod\`, mainnet ids with \`nightmainnet\`; each is kept for its own network and never sent to the other; requests count against the user's Blockfrost plan). The user sets it once with \`midnight config set blockfrost-project-id <project id>\` in their own terminal, or \`BLOCKFROST_PROJECT_ID\` (or \`MN_BLOCKFROST_PROJECT_ID\`) in the MCP server's environment. It is a secret: \`midnight_config_get\` shows it masked, no tool result contains it, and you should never ask for it in chat or echo it. Preview and the local network need none.

`,
    },
    {
      text: 'skill-full',
      section: 'intent-routing',
      order: 0,
      body: `## Intent routing (natural language → tool)

| User says | Call this tool |
|---|---|
`,
    },
    {
      text: 'skill-full',
      section: 'intent-routing',
      order: 1000,
      body: `
`,
    },
    {
      text: 'skill-full',
      section: 'canonical-flows',
      order: 0,
      body: `## Canonical flows

`,
    },
    {
      text: 'skill-full',
      section: 'canonical-flows',
      order: 30,
      body: `**Stale MCP server.** Every MCP response carries \`_serverVersion\`. If the user upgraded \`midnight-wallet-cli\` but \`_serverVersion\` lags \`mn --version\`, the MCP client is talking to a long-lived stale process. Tell them to disconnect and re-add the MCP server (a /mcp reconnect alone will not respawn it).

`,
    },
    {
      text: 'skill-full',
      section: 'safety-rules',
      order: 0,
      body: `## Safety rules (non-negotiable)

- **Read tools** (\`readOnlyHint: true\`) — safe to call without user consent.
- **Destructive tools** (\`destructiveHint: true\`) — require explicit user consent before calling.
- **Open-world tools** (\`openWorldHint: true\`) — touch the network/chain/Docker. Can fail non-deterministically; retry is usually safe for reads, risky for writes.
- **Never** auto-execute a fund-moving operation. Always describe amount + recipient + network first.
- **Never** invent a mnemonic, seed, or private key. If the user needs one, call \`midnight_wallet_generate\`.
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 0,
      body: `## Error recovery recipes

Every MCP tool error returns \`{ error: true, code: <ERROR_CODE>, message: <human prose> }\`. **Index on the \`code\`** — the message is human-targeted and may change. Stable codes:

| Code | Meaning | Recovery |
|---|---|---|
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 1000,
      body: `
`,
    },
    {
      text: 'skill-full',
      section: 'networks',
      order: 0,
      body: `## When to use which network

- **Developing a contract?** → \`undeployed\` (a ledger-9 stack the user runs locally). No first-sync cost; everything is local.
- **Integration testing against a hosted chain?** → \`preprod\`, once it runs ledger 9 (refused while it is on ledger 8). First sync for a new wallet on this network processes full event history; subsequent syncs restore from cache and are much faster.
- **Demoing to users?** → \`preview\` (if the dApp is deployed there) or \`undeployed\` (if self-contained).
- **Mainnet?** → \`mainnet\`, named on every call (\`network: "mainnet"\`); it is never the default. Needs the user's mainnet Blockfrost project id. Moves real value: describe amount, recipient and network and get the user's go-ahead before any write. No faucet; no airdrop, test suites or grants there.

`,
    },
    {
      text: 'skill-full',
      section: 'not-this-cli',
      order: 0,
      body: `## What this CLI is NOT

- Not a custody service. Keys are on the user's disk (\`~/.midnight/wallets/<name>.json\`).
- Not an instant-sync tool for a first-time wallet on a hosted network. First run replays the chain's event history; the CLI caches state after that so repeat runs are fast.
`,
    },
    {
      text: 'skill-full',
      section: 'not-this-cli',
      order: 1000,
      body: `
`,
    },
    {
      text: 'skill-full',
      section: 'references',
      order: 0,
      body: `## Authoritative references

- \`mn help <command>\` — per-command usage and flags.
- \`mn help --agent\` — structured reference manual for AI clients.
- \`mn help --json\` — every command's usage, flags and JSON fields, as JSON.
`,
    },
];

/** The tools behind the two-step confirmation, as a list of names in the registry's order. */
const confirmedTools = (registry: CommandRegistry): string =>
  registry.tools.filter((tool) => tool.confirmation !== undefined).map((tool) => `\`${tool.name}\``).join(', ');

/**
 * What the skills say from the registry: the safety rule on the confirmed
 * tools, in both, and in skill/full the sets of codes the tools' descriptions
 * name and the commands no tool runs, which the user runs in a terminal.
 */
function registryPieces(registry: CommandRegistry): GuidancePiece[] {
  const confirmation = `- **Some tools use a two-step confirmation token**: ${confirmedTools(registry)}. The first call returns a pending token + description and does nothing else; show the description verbatim, and call \`midnight_confirm_operation({ token })\` only after the user explicitly says yes. (\`midnight_wallet_generate\` asks only with \`force: true\`, which replaces a wallet.)`;
  const terminalOnly = registry.commands.filter((command) => command.help !== undefined && (command.mcp?.tools.length ?? 0) === 0).map((command) => `\`mn ${command.name}\``);
  return [
    { text: 'skill-core', section: 'safety-rules', order: 500, body: `${confirmation} Full flow in \`midnight-wallet://skill/full\`.\n\n` },
    { text: 'skill-full', section: 'safety-rules', order: 500, body: `${confirmation}\n\n` },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 999,
      body: `\nA tool's description ends with the codes it can fail with: its own, and sets of them by name. The sets:\n\n| Set | Codes |\n|---|---|\n${declaredCodeSets(registry).map((set) => `| ${set.name} | ${set.codes.map((code) => `\`${code}\``).join(', ')} |\n`).join('')}`,
    },
    {
      text: 'skill-full',
      section: 'what-you-can-do',
      order: 1000,
      body: `\nMost commands are MCP tools (\`tools/list\` shows each, and what it takes). ${terminalOnly.length === 0 ? '' : `These have none, and the user runs them in their own terminal: ${terminalOnly.join(', ')}; some subcommands have none either.`}\n\n`,
    },
  ];
}

function piecesOf(registry: CommandRegistry): GuidancePiece[] {
  return [...SERVER_PIECES, ...registryPieces(registry), ...registry.packages.flatMap((pkg) => pkg.guidance.pieces)];
}

const addedSections = (registry: CommandRegistry) => registry.packages.flatMap((pkg) => pkg.guidance.sections ?? []);

/** skill/core for the installed packages. */
export function skillCore(registry: CommandRegistry): string {
  return assembleGuidance('skill-core', sectionsWithAdded('skill-core', SKILL_CORE_SECTIONS, addedSections(registry)), piecesOf(registry));
}

/** skill/full (and the legacy skill URI) for the installed packages. */
export function skillFull(registry: CommandRegistry): string {
  return assembleGuidance('skill-full', sectionsWithAdded('skill-full', SKILL_FULL_SECTIONS, addedSections(registry)), piecesOf(registry));
}

/** The repository's copies of the skills, by path from its root, and what writes each. */
export const SKILL_DOCS: readonly { readonly path: string; readonly assemble: (registry: CommandRegistry) => string }[] = [
  { path: 'docs/SKILL-CORE.md', assemble: skillCore },
  { path: 'docs/SKILL.md', assemble: skillFull },
];
