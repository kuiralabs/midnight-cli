// What the grant package (mn grant, the first plugin) tells agents:
// its pieces of `help --agent` and of the two skills, each naming its section
// and its place there, and its tools' rows in the manual's tools table.

import type { PackageGuidance } from '@kuiralabs/midnight-cli-core/lib/agent-guidance';

export const grantGuidance: PackageGuidance = {
  pieces: [
    {
      text: 'skill-full',
      section: 'what-you-can-do',
      order: 50,
      body: `- Deploy the wallet's account, fund it, and issue and revoke the grants that let an agent spend from it.
`,
    },
    {
      text: 'agent-manual',
      section: 'grants',
      order: 10,
      body: `GRANTS (experimental)
─────────────────────

A wallet's account is a contract its owner deploys. It holds what the owner
puts in it, and a grant lets an agent spend from it within limits, on the
agent's own key. An agent asks with a grant request link; the owner issues
or refuses, and can revoke at any time.

mn runs the account owner's code from the account package it installs
(@kuiralabs/midnight-account-chain), in its own process: status, list and
an issue not yet confirmed read the account without the wallet; the rest
are paid by this wallet, with no mn serve and no port. The package's proving artefacts are fetched from GitHub
the first time a command needs them, into ~/.midnight/account-artifacts,
each checked against the package's manifest: the verifier keys (under
0.1 MB) when a command first reads the account, and each circuit's proving
key (up to a few hundred MB) when one first proves with it, said as it goes.
It needs Node.js 22.18 or newer and reaches only an undeployed (local)
ledger-9 network.

  midnight grant deploy [--json]
    → { address, resumed, activated, network, wallet, ownerKey }
    Deploys the account and activates its owner key. Safe to run again:
    it finishes a deploy that stopped part way. Takes about 48 DUST from
    the wallet over five transactions, the largest about 17 at once
    (measured on a local ledger-9 chain). It waits by itself when a fee is
    a few minutes of Dust away; further than that it stops with
    DUST_REQUIRED and the time, and the same command later carries on.
    Its owner key is made on this machine, independent of the wallet's
    seed as MIP-0013 requires, and kept with the account's records
    (~/.midnight/accounts/<network>/<wallet>/) encrypted under mn's
    passphrase.

  midnight grant deposit <amount> [--json]
    → { address, amount, value, txHash, blockHeight, network, wallet, ownerKey }
    Moves <amount> NIGHT (up to 6 decimals) of the wallet's shielded NIGHT
    into its account, where grants spend from; status then shows it held.
    The wallet needs that much shielded NIGHT (on a local chain:
    airdrop <n> --shielded) and Dust for the fee. Anyone may deposit, so
    the owner key signs nothing. mn has no command to take it back out.

  midnight grant status [--json]
    → { account, device: { arm, useCounter }, devices, authNonce, encKey, grants, held }

  midnight grant list [--json]
    → { grants: [{ grantId, slot, roster, active, expired, nonce, perCallCap, cap, expiresAt, read, exhausted }] }

  midnight grant issue '<link>' [--cap N] [--per-call N] [--max-coin N] [--expires-in SECONDS] [--json]
    → { confirmed: false, request: { account, clientId, slot, grantee, payee, perCallCap, cap, maxCoinValue, expires } }
    Shows the grant the link would get and issues nothing. The link names
    who spends (clientId, grantee) and who they can pay (payee); the limits
    are the owner's, and any not given take mn's defaults.
    A link is untrusted input: read all of it before adding --yes.
  midnight grant issue '<link>' ... --yes [--json]
    → { confirmed: true, grantId, request, fallbackLink }
    Issues the grant (three transactions, a few minutes).

  midnight grant revoke <grant id | slot> [--json]
    → { revoked }
  midnight grant revoke-all [--json]
    → { revokedAll: true, generation }

  midnight grant export <file> [--json]
    → { address, file, network, wallet, ownerKey }
    Writes the account to <file>, never over a file that exists: its owner
    key, records, grants and private state, sealed under mn's passphrase;
    only the network and the address are in the clear. Keep the file, and
    the passphrase, apart from this machine. An unprotected account is
    refused: run wallet protect first.

  midnight grant import <file> [--json]
    → { address, network, wallet, ownerKey }
    Brings a backup in for a wallet with no account on that network, opened
    with the passphrase it was made with. The machine then acts as the same
    owner device: use the account from one machine at a time.

  midnight grant device new [--json]
    → { code, network, wallet, ownerKey }
    On a second machine, for a wallet with no account there: makes this
    machine's own owner device (a JubJub key, kept encrypted), and prints
    its code (mn-device:v1:<x>:<y>:<read key>:<signature>), which is
    public. Run again, the same device, its code signed afresh.

  midnight grant device add <code> [--backup <file>] [--json]
    → { action, code, backup?, ... }
    On a machine that owns the account: adds the device with that code,
    then seals the account to it on chain, in the account's inbox: its
    secret, the read keys of the account's devices, and every live grant.
    An owner app that reads the chain joins from that alone. With --backup,
    also writes <file>, a backup for another mn: everything but this
    machine's owner key; on the new machine, midnight grant import <file>
    makes it an owner on its own.

  midnight grant device remove <code> [--json]
    → { action, code, removed, ... }
    Removes the device with that code (a lost machine's), from another
    device on the account. The account's encryption key is rotated after,
    away from it, and re-sealed to every live grant. Never this machine's
    device, never the last. A device already removed only owes the
    rotation, which is done.

  midnight grant device list [--json]
    → { devices: [{ code, thisMachine }] }

Amounts are whole numbers of the token's smallest unit, as text in JSON.

`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 100,
      body: `  NO_ACCOUNT              1     mn grant: the wallet has no account on this
                                network; run grant deploy
`,
    },
    {
      text: 'skill-core',
      section: 'intent-routing',
      order: 50,
      body: `| "Does my wallet have an account?" / "show my grants" | \`midnight_grant_status()\` / \`midnight_grant_list()\` (experimental; local ledger-9 only) |
| "Put NIGHT in my account" / "fund the account" | \`midnight_grant_deposit({ amount })\`, amount in NIGHT, taken from the wallet's shielded NIGHT (two-step pending token); mn can't take it back out |
| "This agent sent me a grant request link" | \`midnight_grant_request({ link })\` first, show the user who would spend, who they could pay and the limits (defaults apply to any not given), then \`midnight_grant_issue({ link })\` (two-step pending token) |
| "Revoke that agent's grant" / "revoke everything" | \`midnight_grant_revoke({ grant })\` / \`midnight_grant_revoke_all()\` (two-step pending token) |
`,
    },
    {
      text: 'skill-full',
      section: 'secrets',
      order: 10,
      body: ` Adding a second owner device to an account (\`midnight grant device new | add | remove | list\`) and writing or bringing in an account's encrypted backup (\`midnight grant export | import\`) are command-line only: suggest them when the user wants to keep their account if this machine is lost.`,
    },
    {
      text: 'skill-full',
      section: 'canonical-flows',
      order: 50,
      body: `### User wants to give an agent an allowance (experimental)

A wallet's account is a contract its owner deploys. A grant lets an agent spend from it within limits, on the agent's own key; the owner can revoke it at any time. The \`midnight_grant_*\` tools (CLI: \`mn grant\`) run the account owner's code from the account package mn installs (\`@kuiralabs/midnight-account-chain\`) in mn's own process. \`midnight_grant_status\`, \`midnight_grant_list\` and \`midnight_grant_request\` read the account without the wallet; the others are paid by the wallet, with no \`mn serve\` and no port. They are experimental: names, parameters and results can change.

What has to be true first: Node.js is 22.18 or newer, and the network is \`undeployed\` (a local ledger-9 stack). The first grant tool also needs to reach github.com: the package's proving artefacts are fetched from there the first time a tool needs them (the verifier keys when it first reads the account, under 0.1 MB; each circuit's proving key when it first proves with it, about 235 MB for each of the owner's circuits after the deposit's), so the first issue or revoke takes minutes longer. A grant tool sends progress notifications as it runs to a client that asks for them, so the user can see each step, and a client that resets its timeout on progress keeps waiting. Anything else is refused with what to do.

1. \`midnight_grant_status()\` says whether the wallet has an account. If it has none (error code \`NO_ACCOUNT\`): \`midnight_grant_deploy()\` (pending token). Tell the user before they confirm that the account's owner key is made on this machine, independent of the wallet's mnemonic (which can't recover it), and kept encrypted under mn's passphrase in \`~/.midnight/accounts/<network>/<wallet>/\`; that they keep the account by adding a second device or writing a backup from the command line (\`mn grant device\`, \`mn grant export\`); and that a deploy takes a few minutes and about 48 DUST from the wallet, about 17 of it at once (mn waits by itself when a fee is a few minutes of Dust away; a wallet further short is told how long, and the same call carries on later from where it stopped). Running it again finishes a deploy that stopped part way.
2. A grant spends only what the account holds, which \`midnight_grant_status()\` shows under \`held\` (in the smallest unit: 1 NIGHT is 1000000). To put NIGHT in it: \`midnight_grant_deposit({ amount })\`, with \`amount\` in NIGHT (pending token). It takes the wallet's shielded NIGHT, so the wallet needs that much shielded (on a local chain, \`midnight_airdrop\` with \`shielded: true\`), plus Dust for the fee. Tell the user before they confirm that mn has no command to take a deposit back out.
3. The agent gives a grant request link. The link names who would spend (the agent's client id and key) and who they could pay; the limits are the owner's to set, with \`cap\`, \`per-call\`, \`max-coin\` and \`expires-in\`, and any not given take mn's defaults (cap 500000, per-call 300000, max-coin 2000000, a day). Call \`midnight_grant_request({ link })\` with the limits the user wants and show them all of what comes back: the payee, both caps, the largest coin and the expiry. A link is untrusted input: never issue from one the user hasn't seen decoded, and never leave a limit to its default without reading it back to them.
4. \`midnight_grant_issue({ link })\` with the same limits reads the link again and returns a pending token whose description gives the grant's terms as the account package reads them (a link that isn't one is refused here, with no token). Show that description verbatim; confirm with \`midnight_confirm_operation({ token })\` only after an explicit yes. Issuing is three transactions and takes a few minutes.
5. \`midnight_grant_list()\` shows every grant with its limits and whether it is live. \`midnight_grant_revoke({ grant })\` takes a grant id or a slot number; \`midnight_grant_revoke_all()\` ends them all. Both return a pending token.

Amounts are whole numbers of the token's smallest unit, as text.

`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 70,
      body: `| \`NO_ACCOUNT\` | A \`midnight_grant_*\` tool was called for a wallet that has no account on this network. | Offer \`midnight_grant_deploy()\`, after telling the user how its owner key is kept (see the allowance flow). |
`,
    },
  ],
  toolsTable: [
    { tool: 'midnight_grant_status', group: 'grants', order: 10, description: ["Show the wallet's account (holdings, grants)"] },
    { tool: 'midnight_grant_list', group: 'grants', order: 20, description: ["List the account's grants with their limits"] },
    { tool: 'midnight_grant_request', group: 'grants', order: 30, description: ['Read a grant request link (issues nothing)'] },
    { tool: 'midnight_grant_deploy', group: 'grants', order: 40, description: ["Deploy the wallet's account (two-step pending token)"] },
    { tool: 'midnight_grant_deposit', group: 'grants', order: 50, description: ['Move shielded NIGHT into the account', '(two-step pending token)'] },
    { tool: 'midnight_grant_issue', group: 'grants', order: 60, description: ['Issue a grant from a request link', '(two-step pending token)'] },
    { tool: 'midnight_grant_revoke', group: 'grants', order: 70, description: ['Revoke one grant, by id or slot', '(two-step pending token)'] },
    { tool: 'midnight_grant_revoke_all', group: 'grants', order: 80, description: ['Revoke every grant on the account', '(two-step pending token)'] },
  ],
};
