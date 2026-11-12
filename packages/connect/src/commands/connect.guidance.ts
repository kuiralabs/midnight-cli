// What the connect package (serve, the DApp connector) tells agents:
// its pieces of `help --agent` and of the two skills, each naming its section
// and its place there.

import { codeGuidancePieces, type PackageGuidance } from '@kuiralabs/midnight-cli-core';
import { connectCodes } from './connect.codes.ts';

export const connectGuidance: PackageGuidance = {
  pieces: [
    ...codeGuidancePieces(connectCodes),
    {
      text: 'skill-full',
      section: 'what-you-can-do',
      order: 30,
      body: `- Serve a wallet to a dApp over the DApp connector, including as a fee wallet for an agent's transactions (\`mn serve --approve-fees\`).
`,
    },
    {
      text: 'agent-manual',
      section: 'dapp-connector',
      order: 10,
      body: `DAPP CONNECTOR
──────────────

  midnight serve [--port 9932] [--approve-all | --approve-fees] [--allow-origin <origin>]... [--network name] [--force-shielded]

Starts a WebSocket JSON-RPC server implementing the Midnight
ConnectedAPI interface (same as the Lace browser wallet). Any DApp
can connect to it — no browser extension needed.

  - Port default: 9932, localhost only
  - Browser pages are refused unless their origin is allowed: a page
    connects only with --allow-origin <its origin> (e.g.
    --allow-origin http://localhost:5173; repeat for more). Node scripts
    send no Origin and always connect. A refused page gets HTTP 403, and
    serve prints the origin it refused; allow only your own dApp's page,
    since an allowed page can ask the wallet to sign and spend. --approve-all with an allowed
    origin prints a warning: any script on that page can spend and sign
  - Shielded wallet on mainnet, preview and preprod: serve is ready
    without waiting for the shielded sync, which goes on behind it, so
    shielded balances it reports may be incomplete until it catches up.
    --force-shielded waits for the full shielded sync first; a dApp that
    needs shielded balances or coins there needs it
  - A client calls connect(networkId) first, as the DApp connector API
    has it: any other method before that is refused as Disconnected
  - Read operations: never prompt, except getConfiguration on preprod and
    mainnet: its endpoint URLs carry the user's Blockfrost project id
    (?project_id=...), which a dApp needs to reach them, so serve asks the
    operator once per connection before it gives them (--approve-all gives
    them without asking). Without a terminal, and under --approve-fees with
    nobody to ask, it is refused as APPROVAL_UNAVAILABLE: give the dApp its
    own endpoints (its own Blockfrost project id)
  - A request that needs approval with no terminal to ask at is refused
    as APPROVAL_UNAVAILABLE (PermissionRejected to the dApp), not as a
    rejection: start serve with --approve-all or --approve-fees for that
  - Write operations, balancing included (balanceUnsealedTransaction /
    balanceSealedTransaction sign and return a finished transaction):
    terminal approval prompt (or --approve-all)
  - --approve-fees: fee wallet for an agent. balanceUnsealedTransaction /
    balanceSealedTransaction pay only the Dust fee and are auto-approved when
    the transaction spends none of this wallet's funds, has no unsigned
    unshielded input, and needs no non-Dust value; otherwise they are
    refused. submitTransaction is auto-approved only for a transaction this
    server balanced that way on the same connection. Everything else still
    prompts. --max-fee <DUST> (default 10)
    and --max-pending <n> (default 2) bound what an agent can cost it.
  - A fee the wallet's Dust doesn't cover yet (its NIGHT is still generating
    it): serve waits when the rest is at most 2 minutes away, and otherwise
    refuses at once with DUST_REQUIRED and the time ("generates the rest in
    about 4 minutes"): retry then. mn's own commands (contract, test run,
    grant) wait up to 5 minutes.
  - --json: the listening line reports the approval policy, e.g.
    "approval":{"reads":"auto","balancing":"fee-only","writes":"fee-only","feeLimits":
    {"maxFeeSpecks":"10000000000000000","maxPending":2}}
  - --no-auto-approve-reads: no effect, kept for old scripts
  - getTxHistory lists the transactions this server has seen since it
    began serving, newest first: those submitted through it (pending, then
    finalized or discarded) and those its sync reads after that. What the
    wallet's sync read before serve was ready is left out. It is kept in
    memory, so a restart starts it empty
  - connect and getConnectionStatus give the network id in the SDK's
    lowercase form (undeployed, preview, preprod, mainnet), as does
    getConfiguration
  - A request sent right after connect, before its answer, waits for it

DApp developers connect via the midnight-wallet-connector npm package:

  npm install midnight-wallet-connector

  import { createWalletClient } from 'midnight-wallet-connector';
  const wallet = await createWalletClient({
    url: 'ws://localhost:9932',
    networkId: 'undeployed',  // or 'preprod', 'preview', 'mainnet' — lowercase per @midnightntwrk/wallet-sdk
  });
  const balances = await wallet.getUnshieldedBalances();

Reference DApp: https://github.com/nel349/midnight-starship

`,
    },
    {
      text: 'agent-manual',
      section: 'example-commands',
      order: 30,
      body: `  # Start DApp connector (fee-wallet mode for an agent's own transactions)
  midnight serve --approve-fees
  # DApps connect at ws://localhost:9932
`,
    },
    {
      text: 'skill-full',
      section: 'canonical-flows',
      order: 40,
      body: `### Agent needs a fee wallet for its own dApp transactions

When an agent builds and proves its own ledger-9 transaction (its own value already balanced) and only needs the Dust fee paid, the user runs \`mn serve --approve-fees\` (CLI only, not an MCP tool). In that mode \`balanceUnsealedTransaction\` / \`balanceSealedTransaction\` add only Dust, and are auto-approved only when the transaction spends none of the wallet's funds, has no unsigned unshielded input, needs no non-Dust value, and is not a rewards claim; otherwise they are refused with every reason listed. \`submitTransaction\` is auto-approved only for a transaction that server balanced that way on the same connection. Everything else still prompts the user (and is rejected without a terminal). \`--approve-fees\` cannot be combined with \`--approve-all\`. Two limits bound what an agent can cost the wallet: \`--max-fee <DUST>\` refuses a transaction whose total Dust fee (the agent's transaction plus the wallet's balancing) is higher (default 10 DUST; a simple contract call costs about 0.5), and \`--max-pending <n>\` refuses new balances while n balanced transactions wait to be submitted (default 2). Both are checked before any Dust is reserved. Each balanced transaction reserves a whole Dust coin until it is submitted and on chain (about 20 seconds on a 6-second-block localnet) or released, so a fee wallet serves as many agents at once as it has Dust coins: one per NIGHT UTXO registered for Dust generation. A request that finds none free waits for one, then fails with an error saying so. With \`--json\`, the line \`mn serve\` prints once it is listening includes the approval policy (\`"approval": {"reads": "auto", "balancing": "fee-only", "writes": "fee-only", "feeLimits": {"maxFeeSpecks": "10000000000000000", "maxPending": 2}}\`), so whoever started it can check what it will approve.

`,
    },
  ],
};
