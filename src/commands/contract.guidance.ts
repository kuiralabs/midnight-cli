// What the contract package (contract and inspect-cost) tells agents:
// its pieces of `help --agent` and of the two skills, each naming its section
// and its place there, and its tools' rows in the manual's tools table.

import type { PackageGuidance } from '@kuiralabs/midnight-cli-core/lib/agent-guidance';

export const contractGuidance: PackageGuidance = {
  pieces: [
    {
      text: 'skill-full',
      section: 'what-you-can-do',
      order: 20,
      body: `- Deploy, call, inspect and read Compact smart contracts, and read the chain's block limits.
`,
    },
    {
      text: 'agent-manual',
      section: 'smart-contracts',
      order: 10,
      body: `SMART CONTRACTS
───────────────

Run these commands from the root of a dApp project that contains a
compiled Compact contract (managed/ directory with .js and .d.ts files).
Compile with Compact 0.35 (language 0.27): mn bundles compact-runtime
0.20.0, and code compiled for another runtime is rejected at deploy/call.

  Inspect — show circuits, witnesses, types:
    midnight contract inspect [--path <dir>] [--json]
    → { name, compilerVersion, circuits: [...], witnesses: [...] }

  Deploy — deploy a contract to the network:
    midnight contract deploy [--network <name>] [--json]
    → { contractName, address, network }
    Requires: funded wallet with dust. Auto-starts mn serve if needed.

  Call — call a circuit on a deployed contract:
    midnight contract call --address <addr> --circuit <name> [--args '<json>'] [--json]
    → { contractName, circuit, address, network, status }
    Example: midnight contract call --address abc123... --circuit post --args '["Hello!"]'

  State — read ledger state of a deployed contract:
    midnight contract state --address <addr> [--network <name>] [--json]
    → { address, network, fields: { key: value }, maps: { key: { size } } }

  Full workflow example:
    cd my-dapp
    midnight contract inspect                    # see what circuits exist
    midnight contract deploy                     # deploy to localnet
    midnight contract call --address <addr> --circuit post --args '["Hello"]'
    midnight contract state --address <addr>     # read on-chain state

`,
    },
    {
      text: 'agent-manual',
      section: 'example-commands',
      order: 20,
      body: `  # Contract inspection
  midnight contract inspect --json
  # → {"name":"bboard","compilerVersion":"0.35.0","circuits":[{"name":"post",...}],"witnesses":[...]}

  # Deploy contract (from dApp root directory)
  midnight contract deploy --json
  # → {"subcommand":"deploy","contractName":"bboard","address":"6cc5...","network":"undeployed"}

  # Call a circuit
  midnight contract call --address 6cc5... --circuit post --args '["Hello from CLI!"]' --json
  # → {"subcommand":"call","circuit":"post","status":"success"}

  # Read contract state
  midnight contract state --address 6cc5... --json
  # → {"subcommand":"state","fields":{"state":"1","message":"...","owner":"..."}}

`,
    },
    {
      text: 'skill-core',
      section: 'intent-routing',
      order: 30,
      body: `| "Inspect this contract" / "what circuits does this dApp expose" | \`midnight_contract_inspect({ path })\` |
| "Deploy this contract" / "deploy on undeployed" | \`midnight_contract_deploy({ path, wallet, network })\` — two-step pending token |
| "Call circuit X" / "submit a score" | \`midnight_contract_call({ address, circuit, args })\` — two-step pending token |
| "What's the contract state?" / "read the ledger" | \`midnight_contract_state({ address, path })\` |
`,
    },
    {
      text: 'skill-full',
      section: 'canonical-flows',
      order: 20,
      body: `### User wants to deploy a contract
Use \`midnight_contract_*\` MCP tools (or \`mn contract\` CLI). Flow: \`compact compile\` in the project → \`midnight_contract_inspect({ path })\` to verify artifacts → \`midnight_contract_deploy({ path, wallet, network })\` → returns address → \`midnight_contract_call({ address, circuit, args, ... })\` to exercise it. State reads via \`midnight_contract_state({ address, ... })\`.

**Project layouts handled.** The scan looks for \`managed/<name>/compiler/contract-info.json\` under: project root, \`contract/\`, \`contract/src/\`, \`contracts/\`, \`contracts/src/\`, \`src/\`. If none match, pass \`managed: "<full path to managed/<name>/>"\` directly.

**Multi-contract projects.** Inspect returns a \`siblings: string[]\` field listing other contracts under the same \`managed/\`. Pick one with \`name: "<contract>"\` on inspect/deploy/call/state.

**Arg encoding for circuits.** The MCP \`args\` param is a JSON string. The bridge auto-coerces, recursing into objects and arrays:
- \`number\` (integer, within \`Number.MAX_SAFE_INTEGER\`) → \`BigInt\`
- \`"123n"\` (BigInt-literal syntax) → \`BigInt(123)\` — required for values beyond safe-integer range, e.g. 256-bit field elements in elliptic-curve points like \`{x: "3577…n", y: "5455…n"}\`
- array of \`[0–255]\` ints → \`Uint8Array\` (any Compact \`Bytes<N>\` arg, e.g. \`[1,2,3,…,32]\`)
- objects: each value coerced under the same rules → \`Struct\` args
- arrays (non-byte): each element coerced

Plain strings, booleans, fractional numbers, and \`null\` pass through unchanged. No hex-string detection — \`"1234"\` stays a string.

**Compatibility caveat — runtime version skew.** Contracts must be compiled with Compact 0.35 (language 0.27). The CLI bundles \`@midnight-ntwrk/compact-runtime\` \`0.20.0\`, so contracts have to target runtime \`0.20.0\`. Artifacts built for another runtime (e.g. \`0.16.0\`, from a ledger-8 toolchain) are rejected at deploy/call with a message like \`CompactError: Version mismatch: compiled code expects 0.16.0\`. The fix is to recompile with Compact 0.35 (\`compact compile\`) rather than asking the user to change \`mn\`; a contract that must stay on the ledger-8 toolchain belongs with \`midnight-wallet-cli\` 0.5.x. \`midnight_contract_inspect\` shows the compiled \`runtimeVersion\` so you can flag the mismatch before attempting deploy.

`,
    },
  ],
  toolsTable: [
    { tool: 'midnight_inspect_cost', group: 'balance-info', order: 50, description: ['Display block cost limits'] },
    { tool: 'midnight_contract_inspect', group: 'contracts', order: 10, description: ['Read circuits, witnesses, ledger shape from', 'compiled artifact (no chain access needed)'], params: ['path / managed / name'] },
    { tool: 'midnight_contract_state', group: 'contracts', order: 20, description: ["Query a deployed contract's ledger state"], params: ['address, path'] },
    { tool: 'midnight_contract_deploy', group: 'contracts', order: 30, description: ['Deploy a compiled contract (two-step pending token)'], params: ['path / managed'] },
    { tool: 'midnight_contract_call', group: 'contracts', order: 40, description: ['Call a circuit on a deployed contract', '(two-step pending token; args auto-coerce numbers', 'and "123n" strings to BigInt, [0–255] to Uint8Array)'] },
  ],
};
