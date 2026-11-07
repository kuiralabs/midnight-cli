// The `grant` command, described once.

import { type CommandDefinition, type ToolCheckCall, ENDPOINT_PARAMS, confirmationTarget } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { OPENS_WALLET } from '@kuiralabs/midnight-wallet/commands';

/** A grant request can run: its arguments, the network, the account and the wallet are all in order. */
async function checkGrant(params: Readonly<Record<string, unknown>>, call: ToolCheckCall) {
  const { prepareGrant } = await import('../lib/grant/prepare.ts');
  const root = call.host.paths().stateRoot;
  const prepared = await prepareGrant(call.argv(), root, call.host);
  const { loadWalletConfig, resolveWalletPath } = await import('@kuiralabs/midnight-wallet');
  await loadWalletConfig(resolveWalletPath(root, params.wallet as string | undefined), call.host.engines);
  return prepared;
}

export const grantDefinition: CommandDefinition = {
  name: 'grant',
  order: 170,
  subcommands: [
    'deploy',
    'deposit',
    'status',
    'list',
    'issue',
    'revoke',
    'revoke-all',
    'export',
    'import',
    'device',
  ],
  flags: [
    { name: 'backup', takesValue: true, subcommands: ['device'] },
    {
      name: 'cap',
      takesValue: true,
      subcommands: ['issue'],
      help: [
        '--cap <n>                     issue: the most the grant may ever pay, in the token\'s smallest unit',
        '                              (this and the three below default to mn\'s limits: 500000, 300000,',
        '                              2000000 and a day)',
      ],
      agent: { type: 'string', description: 'Most the grant may ever pay (smallest unit)' },
    },
    {
      name: 'expires-in',
      takesValue: true,
      subcommands: ['issue'],
      help: ['--expires-in <seconds>        issue: how long the grant lasts'],
      agent: { type: 'string', description: 'Seconds the grant lasts' },
    },
    {
      name: 'max-coin',
      takesValue: true,
      subcommands: ['issue'],
      help: ['--max-coin <n>                issue: the largest coin the agent may take to pay from'],
      agent: { type: 'string', description: 'Largest coin the agent may take to pay from' },
    },
    {
      name: 'network',
      takesValue: true,
      help: [
        '--network <name>              Network (default: undeployed; the account package reaches undeployed',
        '                              and stagenet)',
      ],
      agent: { type: 'string', enum: ['undeployed', 'stagenet'], description: 'undeployed (a local ledger-9 stack) or stagenet' },
    },
    {
      name: 'per-call',
      takesValue: true,
      subcommands: ['issue'],
      help: ['--per-call <n>                issue: the most one payment may be'],
      agent: { type: 'string', description: 'Most one payment may be' },
    },
    {
      name: 'token',
      takesValue: true,
      subcommands: ['deposit'],
      help: [
        '--token <type>                deposit: the shielded token to deposit, by its raw type (64 hex',
        '                              characters, as balance lists it); the amount is then a whole number',
        '                              of the token\'s smallest unit. Without it: NIGHT, the amount in NIGHT',
      ],
      agent: { type: 'string', description: 'Shielded token to deposit, raw type (64 hex, as balance lists it); amount then in its smallest unit. Omit for NIGHT' },
    },
    {
      name: 'wallet',
      takesValue: true,
      help: ['--wallet <name>               The wallet that owns the account and pays the fees'],
      agent: { type: 'string', description: 'The wallet that owns the account and pays the fees' },
    },
    {
      name: 'yes',
      takesValue: false,
      subcommands: ['issue'],
      help: [
        '--yes                         issue: issue the grant (without it the grant is only shown)',
      ],
      // midnight_grant_issue sets it once the user has confirmed; midnight_grant_request must never issue.
      agent: { notForAgents: 'a person\'s go-ahead: an agent\'s is midnight_confirm_operation' },
    },
    {
      name: 'node',
      takesValue: true,
      help: ['--node <url>                  Node RPC endpoint'],
      agent: ENDPOINT_PARAMS.node,
    },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>            Indexer WebSocket endpoint'],
      agent: ENDPOINT_PARAMS['indexer-ws'],
    },
    {
      name: 'proof-server',
      takesValue: true,
      help: ['--proof-server <url>          Proof server endpoint'],
      agent: ENDPOINT_PARAMS['proof-server'],
    },
  ],
  help: {
    description: 'This wallet\'s account, and the grants that let an agent spend from it (experimental)',
    usage: 'midnight grant <deploy|deposit|status|list|issue|revoke|revoke-all|export|import|device> [options]',
    flags: [
      'deploy                        Deploy this wallet\'s account and activate its owner key',
      'deposit <amount>              Move <amount> NIGHT of this wallet\'s shielded NIGHT into its account',
      '                              (with --token, <amount> of that shielded token, in its smallest unit)',
      'status                        The account, its owner key and what it holds',
      'list                          Every grant on the account',
      'issue <link>                  Show the grant an agent\'s request link would get; issue it with --yes',
      'revoke <grant id | slot>      Revoke one grant',
      'revoke-all                    Revoke every grant',
      'export <file>                 Write the account to an encrypted backup (owner key, records,',
      '                              grants, private state), opened only with mn\'s passphrase',
      'import <file>                 Bring an account\'s backup in for a wallet with no account',
      'device new                    Make this machine\'s device for an account another owns',
      'device add <code> [--backup <file>]  Add that device; the account reaches it on chain',
      'device remove <code>          Remove a device (a lost one), rotating the account\'s key after',
      'device list                   The account\'s devices this machine knows of',
      { flag: 'yes' },
      { flag: 'cap' },
      { flag: 'per-call' },
      { flag: 'max-coin' },
      { flag: 'expires-in' },
      { flag: 'token' },
      { flag: 'wallet' },
      { flag: 'network' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'proof-server' },
      '--json                        Output structured JSON',
    ],
    examples: [
      'midnight grant deploy',
      'midnight grant deposit 2',
      'midnight grant deposit 500 --token <token type>',
      'midnight grant status',
      'midnight grant issue \'<grant request link>\'',
      'midnight grant issue \'<grant request link>\' --cap 500000 --yes',
      'midnight grant list --json',
      'midnight grant revoke 0',
    ],
    jsonFields: {
      subcommand: 'The grant subcommand that ran',
      network: 'Network name',
      wallet: 'The wallet the account belongs to',
      ownerKey: '"sealed": the owner key and records are encrypted under mn\'s passphrase; "plain-text": an account an earlier mn made, until wallet protect',
      address: 'The account\'s contract address (deploy, deposit)',
      resumed: 'An account already on record was completed, not a new one deployed (deploy)',
      activated: 'The owner key was activated by this run (deploy)',
      account: 'The account\'s contract address (status)',
      grants: 'The grants on the account (list), or their number (status)',
      confirmed: 'Whether the grant was issued, or only shown (issue)',
      request: 'Who would spend, who they can pay, and the limits the grant gets (issue)',
      grantId: 'The issued grant\'s id (issue with --yes)',
      revoked: 'The revoked grant\'s id (revoke)',
      amount: 'The amount deposited, as given: NIGHT, or with --token the token\'s smallest unit (deposit)',
      token: 'The raw type of the token deposited, when it is not NIGHT (deposit with --token)',
      value: 'The same in the token\'s smallest unit, as status and --cap count it (deposit)',
      txHash: 'The deposit\'s transaction (deposit)',
      blockHeight: 'The block it landed in (deposit)',
    },
  },
  // The intro's line for grant sits beside the contract commands.
  intro: { brief: 'Grants that let agents spend', order: 12 },
  needsWalletSdk: true,
  shell: { payer: true },
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND', 'NO_ACCOUNT', 'ACCOUNT_KEYS_UNAVAILABLE', 'CALLER_PIN_UNSUPPORTED', 'NO_PAYER', 'MAINNET_REFUSED'] },
  load: () => import('./grant.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_grant_status',
        description: 'The wallet\'s account: address, owner key, what it holds, number of grants (see skill).',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [{ flag: 'wallet' }, { flag: 'network' }],
        argv: { subcommand: 'status', flags: 'rest' },
        order: 28,
      },
      {
        name: 'midnight_grant_list',
        description: 'Every grant on the wallet\'s account, with its limits and whether it is live.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [{ flag: 'wallet' }, { flag: 'network' }],
        argv: { subcommand: 'list', flags: 'rest' },
        order: 29,
      },
      {
        name: 'midnight_grant_request',
        description: 'What issuing from an agent\'s grant request link would grant: who spends, who they can pay, and the limits (mn\'s defaults for any not given). Issues nothing. Show the user this before midnight_grant_issue.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [
          { name: 'link', schema: { type: 'string', description: 'The grant request link' } },
          { flag: 'cap' },
          { flag: 'per-call' },
          { flag: 'max-coin' },
          { flag: 'expires-in' },
          { flag: 'wallet' },
          { flag: 'network' },
        ],
        required: ['link'],
        argv: { subcommand: 'issue', positionals: ['link'], flags: 'rest' },
        order: 30,
      },
      {
        name: 'midnight_grant_deploy',
        description: 'Deploy the wallet\'s account and activate its owner key (returns pending token). Takes about 48 DUST from the wallet (17 at once for the largest of five transactions) and a few minutes. Its owner key is made on this machine and kept encrypted under mn\'s passphrase (MN_PASSPHRASE).',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [{ flag: 'wallet' }, { flag: 'network' }],
        argv: { subcommand: 'deploy', flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            return `Deploy an account for ${wallet} on ${network}; its owner key is made on this machine and kept encrypted under mn's passphrase`;
          },
          async check(params, call) {
            await checkGrant(params, call);
          },
        },
        order: 31,
      },
      {
        name: 'midnight_grant_deposit',
        description: 'Move shielded NIGHT, or another shielded token with token, from the wallet into its account, where a grant lets an agent spend it (returns pending token). The wallet needs that much of it shielded, plus Dust for the fee. mn has no command to take it back out.',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { name: 'amount', schema: { type: 'string', description: 'NIGHT to deposit, e.g. "2" (up to 6 decimals); with token, a whole number of its smallest unit' } },
          { flag: 'token' },
          { flag: 'wallet' },
          { flag: 'network' },
        ],
        required: ['amount'],
        argv: { subcommand: 'deposit', positionals: ['amount'], flags: 'rest' },
        confirmation: {
          // The user confirms the deposit as the check found it: both units, and the account.
          async check(params, call) {
            const { request, walletName, target, account } = await checkGrant(params, call);
            if (request.subcommand !== 'deposit' || account === null) throw new Error('A deposit was prepared as something else');
            const what = request.token === undefined ? `${request.amount} shielded NIGHT (${request.value} in the smallest unit)` : `${request.value} of shielded token ${request.token} (in its smallest unit)`;
            return `Deposit ${what} from wallet ${walletName} into its account ${account.address} on ${target.network}`;
          },
        },
        order: 32,
      },
      {
        name: 'midnight_grant_issue',
        description: 'Issue a grant from an agent\'s request link (returns pending token, whose description gives the grant\'s terms as the account package read them). Lets that agent spend from the account within the limits.',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { name: 'link', schema: { type: 'string', description: 'The grant request link' } },
          { flag: 'cap' },
          { flag: 'per-call' },
          { flag: 'max-coin' },
          { flag: 'expires-in' },
          { flag: 'wallet' },
          { flag: 'network' },
        ],
        required: ['link'],
        argv: { subcommand: 'issue', positionals: ['link'], flags: 'rest', fixedFlags: { yes: true } },
        confirmation: {
          // The link is read by the account package before a token is issued: a link
          // that isn't one is refused here, and the user confirms the grant's terms
          // as the build reports them, not a link they can't read.
          async check(params, call) {
            await checkGrant(params, call);
            const shownOnly = call.argv();
            delete shownOnly.flags.yes;
            const shown = await call.run(shownOnly);
            const { describeGrantTerms } = await import('../lib/grant/request.ts');
            return `Issue a grant on ${shown.wallet}'s account on ${shown.network}, letting an agent spend from it within these terms `
              + `(amounts in the token's smallest unit; limits not given took mn's defaults): ${describeGrantTerms(shown.request)}`;
          },
        },
        order: 33,
      },
      {
        name: 'midnight_grant_revoke',
        description: 'Revoke one grant, by its id or slot (returns pending token).',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { name: 'grant', schema: { type: 'string', description: 'Grant id (64 hex) or slot number' } },
          { flag: 'wallet' },
          { flag: 'network' },
        ],
        required: ['grant'],
        argv: { subcommand: 'revoke', positionals: ['grant'], flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            return `Revoke grant ${params.grant} on ${wallet}'s account on ${network}`;
          },
          async check(params, call) {
            await checkGrant(params, call);
          },
        },
        order: 34,
      },
      {
        name: 'midnight_grant_revoke_all',
        description: 'Revoke every grant on the wallet\'s account (returns pending token).',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [{ flag: 'wallet' }, { flag: 'network' }],
        argv: { subcommand: 'revoke-all', flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            return `Revoke every grant on ${wallet}'s account on ${network}`;
          },
          async check(params, call) {
            await checkGrant(params, call);
          },
        },
        order: 35,
      },
    ],
  },
};
