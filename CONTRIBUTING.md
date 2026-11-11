# Contributing to midnight-wallet-cli

Thanks for your interest. This is an open project and contributions are welcome — bug reports, fixes, new features, docs improvements, and feedback on the agent-facing surface (MCP, `--json`, `--agent` flag).

## Getting set up

```bash
git clone https://github.com/kuiralabs/midnight-cli.git
cd midnight-cli
npm install
```

You also need:

- **Node.js >= 22** (22.18 or newer for `mn grant`)
- **Bun >= 1.3** — only for `npm run build`, which bundles `dist/` with `bun build`. Upgrade with `bun upgrade` if `npm run build` misbehaves.
- **Docker** — for `mn localnet` integration testing, and for a proof server at `localhost:6300` if you're testing transactions (`mn localnet up` starts one with a ledger-9 node and indexer)

## The dev loop

```bash
# Run the CLI from source (no rebuild needed)
npx tsx --conditions=midnight-cli-source src/wallet.ts <command>   # or: npm run wallet -- <command>

# Run the MCP server from source
npx tsx --conditions=midnight-cli-source src/mcp-server.ts         # or: npm run mcp

# Build the production bundles (dist/wallet.js + dist/mcp-server.js, and the chunks they load on demand)
npm run build

# Type-check
npm run typecheck

# Tests
npm test           # one-shot
npm run test:watch # vitest watch mode
```

`--conditions=midnight-cli-source` makes each `@kuiralabs/*` workspace package resolve to its TypeScript source instead of its built `dist/`, so a change in `packages/` runs without building it.

The tests live beside the code they test: `src/__tests__/` for the shell and the MCP server, `packages/<name>/src/__tests__/` for each package. They run against real interfaces — no mocks of our own code (per the project's testing standards in CLAUDE.md). External SDK boundaries may be stubbed when needed for isolation.

## Project layout

```
src/                 The shell: mn's command line and MCP server
  commands/          help and manual
  lib/               Dispatch, the agent manual, the MCP server's skills, generated tables
  __tests__/         Tests of the shell, and of what spans packages
  wallet.ts          CLI entry point
  mcp-server.ts      MCP server entry point
packages/
  cli-core/          The host, typed errors and codes, running a command, terminal UI
  chain/             Read-only network access: node, indexer and proof-server readiness, the ledger guard
  engine-rc/         The SDK engine: everything mn does with the wallet SDK, ledger and midnight-js
  wallet/            Wallets, passphrase, balances, transfers, airdrops, Dust, swaps
  contract/          Contract inspect, deploy, call and state
  connect/           mn serve, the DApp connector server
  dev/               mn dev, mn test and mn localnet
  grant/             mn grant, the account and its grants
  connector/         midnight-wallet-connector, the client a dApp connects to mn serve with
  dust-sync-*/       The native Dust reader's per-platform packages (binaries built by CI)
  <name>/src/        commands/ (definitions, guidance, codes), lib/ (pure logic), __tests__/
sidecar/dust-sync/   The native Dust reader (Rust)
test-support/        What tests of several packages share (stand-in servers, the test host)
scripts/             Generators and checks (skill docs, README tables, API reports, layering)
docs/
  SKILL.md           Agent reference (the skill/full MCP resource; generated)
  SKILL-CORE.md      Slim agent reference for session start (generated)
  JSON_CONTRACT.md   What --json prints, and the error codes
```

`node scripts/check-layering.mjs` checks which package may import which. Read `CLAUDE.md` at the repo root for the full engineering standards (modularity, error handling, naming, testing conventions).

## Pull request workflow

1. **Open an issue first** for non-trivial changes so we can align on the approach before you write code.
2. **Branch from `main`.** Keep PRs focused — one logical change per PR.
3. **Write or update tests.** Every bug fix needs a regression test; every new feature needs unit tests beside its code.
4. **Run the full check before pushing:**
   ```bash
   npm run typecheck
   npm test
   node scripts/check-layering.mjs
   node scripts/api-report.mjs check
   npm run build
   ```
5. **Commit messages** say what changed for the user in one plain sentence (look at `git log` for examples). Keep the subject line under ~72 chars. Add a body if the why isn't obvious from the diff.
6. **Open the PR** with a clear description: what changed, why, and how to verify. Link the related issue.

## Code standards (the short version)

- **TypeScript everywhere.** Run via `tsx`, no transpile step in dev.
- **No new dependencies** without discussion. The CLI deliberately uses Node's native `readline` (not inquirer), raw ANSI codes (not chalk), and manual argv parsing (not commander/yargs).
- **Single responsibility per file.** Commands parse args + format output; pure logic lives in a package's `lib/`; UI lives in core's `ui/`.
- **No mocks of our own code.** If you need to mock it, the boundary is wrong — refactor instead.
- **Errors are typed and meaningful.** Throw from `lib/`, catch and format in `commands/`. Every user-facing error includes what went wrong AND what to do about it.
- **Don't break the agent surface.** `--json`, `--agent`, and the MCP tool shapes are an API. If you change them, update the agent guidance of the package whose commands changed (`packages/<name>/src/commands/<name>.guidance.ts`), run `npm run skill-docs` to regenerate `docs/SKILL.md` and `docs/SKILL-CORE.md`, `npm run readme-commands` and `npm run package-readmes` for the generated tables, and `npm run api-report` for a package's exports.

## Reporting bugs

[Open an issue](https://github.com/kuiralabs/midnight-cli/issues) with:

- What you ran
- What you expected
- What actually happened (include stderr — it carries the chrome)
- Output of `mn --version` and `node --version`
- Network (`undeployed` / `preprod` / `preview` / `mainnet`) and whether localnet is up

For agent / MCP issues, include the MCP client (Claude Code, Cursor, etc.) and the response with `_serverVersion` so we can rule out stale installs.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
