// What the contract package (contract and inspect-cost) tells agents:
// its pieces of `help --agent` and of the two skills, each naming its section
// and its place there, and its tools' rows in the manual's tools table.

import { codeGuidancePieces, type PackageGuidance } from '@kuiralabs/midnight-cli-core';
import { contractCodes } from './contract.codes.ts';

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
Compile with Compact 0.36 (language 0.28): mn bundles compact-runtime
0.21.0, and code compiled for another runtime is rejected at deploy/call.

  Inspect — show circuits, witnesses, types:
    midnight contract inspect [--path <dir>] [--json]
    → { name, compilerVersion, circuits: [...], witnesses: [...] }

  Deploy — deploy a contract to the network:
    midnight contract deploy [--network <name>] [--dry-run] [--json]
    → { contractName, address, network, txHash, receipt, cost }
    Requires: funded wallet with dust. Auto-starts mn serve if needed.

  Call — call a circuit on a deployed contract:
    midnight contract call --address <addr> --circuit <name> [--args '<json>' | --args-file <path> | --args -] [--dry-run] [--json]
    → { contractName, circuit, address, network, status, txHash, receipt, cost, freshCoins, heldCoins }
    Example: midnight contract call --address abc123... --circuit post --args '["Hello!"]'

  Arguments (deploy, call): a JSON array, in the circuit's order, or an
  object, read by its values in order: its keys are not matched to the
  parameters' names, so list them in the circuit's order. A circuit's
  arguments are private inputs to its proof unless the contract discloses
  them (a bid, a vote, a coin's nonce). --args '<json>' is for public values: on the command line they
  are in ps and the shell's history. Give private ones with
  --args-file <path> or --args - (the standard input):
    echo '{"bid": 5}' | midnight contract call --address <addr> --circuit bid --args -
  mn warns (stderr; with --json, in "warnings") when --args gives an
  argument the circuit's ZK IR shows it keeps private. Either way the
  contract script gets its arguments through a 0600 file under
  ~/.midnight/contract-args/, deleted when it ends: never in its text, its
  argv or the dApp's folder.

  A fresh shielded coin as an argument (call), wherever the circuit takes
  a ShieldedCoinInfo:
    {"@coin": {"amount": "3", "token": "NIGHT"}}
  mn makes a random nonce, the token's colour (NIGHT, or a token's raw
  type as 64 hex) and the value in its smallest unit (a NIGHT amount has
  up to 6 decimals; another token's is a whole number of its smallest
  unit). The result's freshCoins gives each one's nonce (hex), by which a
  contract may name the coin later.

  Coins the contract holds (call): after a call whose circuit takes a
  ShieldedCoinInfo lands, mn finds the output it made for the contract,
  its Merkle tree index from the indexer, and records the coin in the
  contract's private state, keyed by its nonce in hex, where the next
  call finds it:
    privateState.mnHeldCoins["<nonce hex>"] = { nonce, color, value, mt_index }
  (heldCoins in the result: argument, commitment, mtIndex). A witness that
  spends a coin the contract keeps privately (only a commitment of it on
  chain) returns it from there:
    held_coin: ({ privateState }, nonce) =>
      [privateState, privateState.mnHeldCoins[Buffer.from(nonce).toString('hex')]]

  Cost (deploy, call): after the wallet syncs and before anything is
  proven, mn prices the transaction the way the wallet will pay for it.
    cost → { fee, committed, have, covers, waitSeconds, marginBlocks }
    fee: the expected fee at the chain's fee prices now (DUST, decimal string)
    committed: the Dust the wallet commits to it, the fee with its margin
      of rising prices (marginBlocks), all of it burned
    have / covers: the wallet's Dust, and whether it covers committed
    waitSeconds: how long its registered NIGHT takes to generate the rest
      (0 when it covers; null when not within a day: register more NIGHT)
  A deploy proves no circuit: what it commits comes out the same, and the
  chain's fee within about 0.1%. A call's proofs are priced at the
  ledger's 4832-byte estimate, so its cost differs by a few percent (a
  counter's increment: about 3% less than priced).
  --dry-run prices and stops: nothing is proven or sent, exit 0, and the
  result has dryRun: true and no address, txHash or receipt.
  A wallet short of Dust waits for it, saying so on stderr every 15 s, in
  --json too (plain lines; stdout stays the result):
    Dust: waited 45 s of 104 s, 0.76 of 1.23 DUST

  A failed assert in the circuit (or the constructor, for a deploy) is
  CONTRACT_ASSERTION_FAILED, exit 2: the message names the contract, the
  circuit and the assert's own text. Nothing was sent or paid; the same
  call fails the same way until its arguments or the contract's state change.

  Private state (deploy, call): kept under mn's state root, one store per
  contract, ~/.midnight/contract-state/<network>/<address>/ (owner-only),
  so a call from any folder finds what its deploy left. A call starts
  from the stored private state, what the last call's witnesses left; it
  is seeded (the wallet's secret, or --secret-key) only when none is
  stored yet, as on the first call from a machine with no store. A
  midnight-level-db folder an earlier mn left in the dApp is moved out once
  (said on stderr; with --json, in "warnings").

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
  # → {"name":"bboard","compilerVersion":"0.36.0","circuits":[{"name":"post",...}],"witnesses":[...]}

  # Deploy contract (from dApp root directory)
  midnight contract deploy --json
  # → {"subcommand":"deploy","contractName":"bboard","address":"6cc5...","network":"undeployed","txHash":"e432...","receipt":{...},"cost":{...}}

  # What a deploy costs, without deploying
  midnight contract deploy --dry-run --json
  # → {"subcommand":"deploy","contractName":"counter","network":"undeployed","dryRun":true,"cost":{"fee":"1.075820342856952","committed":"1.2310452531272","have":"0.388954231668571","covers":false,"waitSeconds":102,"marginBlocks":3}}

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
| "Deploy this contract" / "deploy on undeployed" | \`midnight_contract_deploy({ path, wallet, network })\` — two-step pending token, whose description gives the expected cost |
| "What would deploying this cost?" | \`midnight_contract_deploy({ path, wallet, network })\` — the pending token's description gives the cost; don't confirm it |
| "Call circuit X" / "submit a score" | \`midnight_contract_call({ address, circuit, args })\` — two-step pending token; private arguments (a bid, a vote, a coin's nonce) go in a JSON file: \`args-file\` |
| "What's the contract state?" / "read the ledger" | \`midnight_contract_state({ address, path })\` |
`,
    },
    {
      text: 'skill-full',
      section: 'canonical-flows',
      order: 20,
      body: `### User wants to deploy a contract
Use \`midnight_contract_*\` MCP tools (or \`mn contract\` CLI). Flow: \`compact compile\` in the project → \`midnight_contract_inspect({ path })\` to verify artifacts → \`midnight_contract_deploy({ path, wallet, network })\` → returns address → \`midnight_contract_call({ address, circuit, args, ... })\` to exercise it. State reads via \`midnight_contract_state({ address, ... })\`.

**Cost before confirming.** \`midnight_contract_deploy\` prices the deploy before it issues its token (the wallet syncs and the transaction is built; nothing is proven or sent), and the token's description gives the expected fee, the Dust the wallet commits to it (the fee with its margin, all of it burned), the Dust it holds, and whether that covers it or how long its NIGHT takes to. Show that to the user before they confirm. When the price can't be had (the chain out of reach, a wallet with no NIGHT), the description says why in its place. On the CLI, \`mn contract deploy --dry-run\` and \`mn contract call --dry-run\` price and stop.

**Project layouts handled.** The scan looks for \`managed/<name>/compiler/contract-info.json\` under: project root, \`contract/\`, \`contract/src/\`, \`contracts/\`, \`contracts/src/\`, \`src/\`. If none match, pass \`managed: "<full path to managed/<name>/>"\` directly.

**Multi-contract projects.** Inspect returns a \`siblings: string[]\` field listing other contracts under the same \`managed/\`. Pick one with \`name: "<contract>"\` on inspect/deploy/call/state.

**Arg encoding for circuits.** The MCP \`args\` param is a JSON string. The bridge auto-coerces, recursing into objects and arrays:
- \`number\` (integer, within \`Number.MAX_SAFE_INTEGER\`) → \`BigInt\`
- \`"123n"\` (BigInt-literal syntax) → \`BigInt(123)\` — required for values beyond safe-integer range, e.g. 256-bit field elements in elliptic-curve points like \`{x: "3577…n", y: "5455…n"}\`
- array of \`[0–255]\` ints → \`Uint8Array\` (any Compact \`Bytes<N>\` arg, e.g. \`[1,2,3,…,32]\`)
- objects: each value coerced under the same rules → \`Struct\` args
- arrays (non-byte): each element coerced

Plain strings, booleans, fractional numbers, and \`null\` pass through unchanged. No hex-string detection — \`"1234"\` stays a string.

**Private arguments.** A circuit's arguments are private inputs to its proof unless the contract discloses them. \`args\` is text in your tool call, which the host keeps: give private values in a JSON file with \`args-file\` instead (the same array or object). The confirmation and results never repeat argument values, only that arguments were given; a call whose \`args\` hold one the circuit keeps private says so in \`warnings\`. The contract script gets them through an owner-only file mn deletes, never its text or argv.

**A fresh coin.** \`{"@coin": {"amount": "3", "token": "NIGHT"}}\` stands for a new shielded coin wherever the circuit takes a \`ShieldedCoinInfo\` (a random nonce, NIGHT's colour or a raw type given as 64 hex, the value in the smallest unit). The result's \`freshCoins\` gives its nonce. After the call lands, mn records each coin it gave the contract in the contract's private state under \`mnHeldCoins\` (by nonce, with its Merkle tree index), where a witness that spends a privately held coin reads it.

**Compatibility caveat — runtime version skew.** Contracts must be compiled with Compact 0.36 (language 0.28). The CLI bundles \`@midnight-ntwrk/compact-runtime\` \`0.21.0\`, so contracts have to target runtime \`0.21.0\`. Artifacts built for another runtime (e.g. \`0.16.0\`, from a ledger-8 toolchain) are rejected at deploy/call with a message like \`CompactError: Version mismatch: compiled code expects 0.16.0\`. The fix is to recompile with Compact 0.36 (\`compact compile\`): no network runs ledger 8 any more, so there is no older \`mn\` to fall back to. \`midnight_contract_inspect\` shows the compiled \`runtimeVersion\` so you can flag the mismatch before attempting deploy.

`,
    },
    // Its error codes' rows in the manual and the full skill, from their definitions.
    ...codeGuidancePieces(contractCodes),
  ],
  toolsTable: [
    { tool: 'midnight_inspect_cost', group: 'balance-info', order: 50, description: ['Display block cost limits'] },
    { tool: 'midnight_contract_inspect', group: 'contracts', order: 10, description: ['Read circuits, witnesses, ledger shape from', 'compiled artifact (no chain access needed)'], params: ['path / managed / name'] },
    { tool: 'midnight_contract_state', group: 'contracts', order: 20, description: ["Query a deployed contract's ledger state"], params: ['address, path'] },
    { tool: 'midnight_contract_deploy', group: 'contracts', order: 30, description: ['Deploy a compiled contract (two-step pending token,', 'whose description gives the expected cost)'], params: ['path / managed'] },
    { tool: 'midnight_contract_call', group: 'contracts', order: 40, description: ['Call a circuit on a deployed contract', '(two-step pending token; args auto-coerce numbers', 'and "123n" strings to BigInt, [0–255] to Uint8Array;', 'private ones in args-file; {"@coin": ...} a fresh coin)'] },
  ],
};
