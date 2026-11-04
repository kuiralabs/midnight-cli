// What the swap package (mn swap) tells agents: its pieces of `help --agent`
// and of the full skill, the manual section it adds, and its tools' rows.

import type { PackageGuidance } from '@kuiralabs/midnight-cli-core';

export const swapGuidance: PackageGuidance = {
  sections: [{ text: 'agent-manual', name: 'swaps', after: 'grants' }],
  pieces: [
    {
      text: 'skill-full',
      section: 'what-you-can-do',
      order: 45,
      body: `- Swap one shielded token for another privately with another wallet, through an offer file: make it, inspect it, take it at the agreed terms.
`,
    },
    {
      text: 'agent-manual',
      section: 'swaps',
      order: 10,
      body: `SWAPS (experimental)
────────────────────

Two wallets swap shielded tokens privately. The maker proves and signs its
half of the swap (what it gives, and what it wants paid back to itself) and
writes an offer file; the taker checks the file, adds its half and the whole
fee, and submits. Neither side can change the other's terms. Tokens are
named by their raw type (64 hex) and amounts are in the smallest unit.

  midnight swap make --give <n> --give-token <type> --want <n> --want-token <type>
                     [--expires-in <seconds>] [--out <file>] [--json]
    → { id, file, terms, expiresAt, network }
  midnight swap inspect <file> [--json]
    → { id, terms, expiresAt, live, expired, network }
  midnight swap take <file> --give <n> --give-token <type> --want <n> --want-token <type> [--json]
    → { id, txHash, network }
  midnight swap cancel <id> [--json]
    → { id, cancelled, txHash, network }
  midnight swap list [--json]
    → { offers: [{ id, terms, madeAt, expiresAt, expired, taken }], network }

take states the terms as the maker states them (what the maker gives and
wants). Before the taker's wallet builds anything, take refuses an offer
whose terms differ (TERMS_MISMATCH), one past its expiry (OFFER_EXPIRED),
one already taken, and a file that is not an offer or says other than its
transaction (NOT_AN_OFFER). An offer's coins stay committed until it is
taken: the maker's own spends that would use them are refused
(OFFER_COINS_IN_USE). The expiry is mn's own: the chain lets an expired
offer be taken until its maker cancels it, which spends its coins back to
the maker (a fee in Dust).

`,
    },
  ],
  toolsTable: [
    { tool: 'midnight_swap_make', group: 'swaps', order: 10, description: ['Make a swap offer file', '(two-step pending token)'] },
    { tool: 'midnight_swap_inspect', group: 'swaps', order: 20, description: ['What an offer file offers, and whether it is live'] },
    { tool: 'midnight_swap_take', group: 'swaps', order: 30, description: ['Take an offer at the agreed terms', '(two-step pending token)'] },
    { tool: 'midnight_swap_cancel', group: 'swaps', order: 35, description: ['Cancel an open offer, spending its coins back', '(two-step pending token)'] },
    { tool: 'midnight_swap_list', group: 'swaps', order: 40, description: ["The wallet's open offers, and which were taken"] },
  ],
};
