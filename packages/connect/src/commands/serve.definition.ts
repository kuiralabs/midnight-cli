// The `serve` command, described once.

import type { CommandDefinition } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { OPENS_WALLET } from '@kuiralabs/midnight-wallet/commands';

export const serveDefinition: CommandDefinition = {
  name: 'serve',
  order: 130,
  flags: [
    {
      name: 'approve-all',
      takesValue: false,
      help: ['--approve-all                 Auto-approve all requests (reads + writes)'],
    },
    {
      name: 'allow-origin',
      takesValue: true,
      help: [
        '--allow-origin <origin>       Let a browser page from this origin connect, e.g.',
        '                              http://localhost:5173 (repeat for more). Without it,',
        '                              every connection from a browser page is refused',
      ],
    },
    {
      name: 'approve-fees',
      takesValue: false,
      help: [
        '--approve-fees                Fee wallet: auto-approve only Dust-fee balancing of a',
        '                              transaction that needs nothing else from this wallet,',
        '                              and the submit of what it balanced; other writes prompt',
      ],
    },
    {
      name: 'force-shielded',
      takesValue: false,
      help: [
        '--force-shielded              On preview and preprod: wait for the shielded',
        '                              sync before serving. Without it serve is ready once',
        '                              unshielded and Dust are synced, and shielded keeps',
        '                              syncing behind it, so shielded balances it reports may',
        '                              be incomplete until that sync catches up',
      ],
    },
    {
      name: 'max-fee',
      takesValue: true,
      help: [
        '--max-fee <DUST>              With --approve-fees: refuse a transaction whose total',
        '                              Dust fee is higher (default 10 DUST)',
      ],
    },
    {
      name: 'max-pending',
      takesValue: true,
      help: [
        '--max-pending <n>             With --approve-fees: refuse new balances while n',
        '                              balanced transactions await submission (default 2)',
      ],
    },
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>              Override network detection'],
    },
    {
      name: 'no-auto-approve-reads',
      takesValue: false,
      help: [
        '--no-auto-approve-reads       No effect (kept for old scripts): reads never prompt,',
        '                              and balancing prompts by default',
      ],
    },
    { name: 'no-cache', takesValue: false },
    {
      name: 'port',
      takesValue: true,
      help: ['--port <n>                    Server port (default: 9932)'],
    },
    {
      name: 'verbose',
      takesValue: false,
      help: ['--verbose                     Print diagnostic lines about the sync to stderr'],
    },
    {
      name: 'wallet',
      takesValue: true,
      help: ['--wallet <name|file>          Wallet name or path'],
    },
    {
      name: 'node',
      takesValue: true,
      help: ['--node <url>                  Override substrate node RPC URL'],
    },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>            Override indexer WebSocket URL'],
    },
    {
      name: 'proof-server',
      takesValue: true,
      help: ['--proof-server <url>          Override proof server URL'],
    },
  ],
  help: {
    description: 'Start DApp Connector server over WebSocket JSON-RPC',
    usage: 'midnight serve [--port <n>] [--wallet <name|file>] [--network <name>] [--proof-server <url>] [--node <url>] [--indexer-ws <url>] [--approve-all | --approve-fees [--max-fee <DUST>] [--max-pending <n>]] [--allow-origin <origin>]... [--force-shielded] [--no-auto-approve-reads] [--verbose] [--json]',
    flags: [
      { flag: 'port' },
      { flag: 'wallet' },
      { flag: 'network' },
      { flag: 'proof-server' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'approve-all' },
      { flag: 'approve-fees' },
      { flag: 'max-fee' },
      { flag: 'max-pending' },
      { flag: 'allow-origin' },
      { flag: 'force-shielded' },
      { flag: 'no-auto-approve-reads' },
      { flag: 'verbose' },
    ],
    examples: [
      'midnight serve',
      'midnight serve --port 8080',
      'midnight serve --approve-all',
      'midnight serve --approve-fees',
      'midnight serve --allow-origin http://localhost:5173',
    ],
    jsonFields: {
      port: 'Server port number',
      network: 'Network name',
      address: 'Wallet address (bech32m)',
      status: 'Server status (listening)',
      approval: 'What it approves without asking: reads, balancing, writes (and feeLimits under --approve-fees)',
      allowedOrigins: 'Browser origins whose pages may connect (empty: every browser page is refused)',
      warning: 'Present when --approve-all lets browser pages connect: what that exposes',
    },
  },
  intro: { brief: 'DApp Connector server', order: 16 },
  needsWalletSdk: true,
  shell: {},
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND'] },
  load: () => import('./serve.ts'),
};
