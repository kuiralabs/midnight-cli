// The `contract` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM, confirmationTarget } from '../lib/command-definition.ts';

/** The subcommands that reach a chain: inspect reads only the compiled contract (--path, --managed, --name). */
const ON_CHAIN: readonly string[] = ['deploy', 'call', 'state'];

/** The wallet a deploy or call pays from exists and can be read. */
async function checkSendingWallet(params: Readonly<Record<string, unknown>>): Promise<void> {
  const { loadWalletConfig, resolveWalletPath } = await import('../lib/wallet-config.ts');
  await loadWalletConfig(resolveWalletPath(params.wallet as string | undefined));
}

export const contractDefinition: CommandDefinition = {
  name: 'contract',
  order: 160,
  subcommands: ['inspect', 'deploy', 'call', 'state'],
  flags: [
    {
      name: 'address',
      takesValue: true,
      subcommands: ['call', 'state'],
      help: ['--address <addr>              Contract address (call, state)'],
      agent: { type: 'string', description: 'Contract address (hex)' },
    },
    {
      name: 'args',
      takesValue: true,
      subcommands: ['deploy', 'call'],
      help: [
        '--args \'<json>\'               JSON arguments — constructor args (deploy) or circuit args (call). Numbers auto-coerce to BigInt; "123n" strings parse as BigInt; arrays of 0–255 ints become Uint8Array',
      ],
      agent: { type: 'string', description: 'JSON-encoded array or object of circuit arguments' },
    },
    {
      name: 'circuit',
      takesValue: true,
      subcommands: ['call'],
      help: ['--circuit <name>              Circuit to call (call)'],
      agent: { type: 'string', description: 'Circuit name to invoke' },
    },
    {
      name: 'managed',
      takesValue: true,
      help: [
        '--managed <dir>               Direct path to managed/<name>/ directory (all subcommands)',
      ],
      agent: { type: 'string', description: 'Direct path to a managed/<name>/ directory (overrides path-based contract scan)' },
    },
    {
      name: 'name',
      takesValue: true,
      help: [
        '--name <contract>             Specific contract when the project ships multiple (all subcommands)',
      ],
      agent: { type: 'string', description: 'Specific contract name when the project has multiple' },
    },
    {
      name: 'network',
      takesValue: true,
      subcommands: ON_CHAIN,
      help: ['--network <name>              Override network (default: undeployed)'],
      agent: NETWORK_PARAM,
    },
    {
      name: 'path',
      takesValue: true,
      help: ['--path <dir>                  dApp directory (all subcommands; default: cwd)'],
      agent: { type: 'string', description: 'dApp directory (defaults to cwd)' },
    },
    {
      name: 'secret-key',
      takesValue: true,
      subcommands: ['deploy'],
      help: [
        '--secret-key <64-hex>         Seed a caller-chosen initial private-state secret (deploy). For contracts whose constructor derives its owner from public_key(secret_key()); passed to the deploy subprocess via env, never written to disk',
      ],
      agent: {
        type: 'string',
        description: 'A chosen initial private-state secret, 64 hex chars, for a contract whose constructor derives its owner from public_key(secret_key()); passed to the deploy via env, never written to disk',
      },
    },
    {
      name: 'wallet',
      takesValue: true,
      subcommands: ['deploy', 'call', 'state'],
      help: ['--wallet <name>               Wallet to use for the operation (deploy, call, state)'],
      agent: { type: 'string' },
    },
    {
      name: 'node',
      takesValue: true,
      subcommands: ON_CHAIN,
      agent: ENDPOINT_PARAMS.node,
      help: [
        '--node <url>                  Node RPC endpoint (overrides the network default and local auto-detection)',
      ],
    },
    {
      name: 'indexer-ws',
      takesValue: true,
      subcommands: ON_CHAIN,
      help: ['--indexer-ws <url>            Indexer WebSocket endpoint'],
      agent: ENDPOINT_PARAMS['indexer-ws'],
    },
    {
      name: 'proof-server',
      takesValue: true,
      subcommands: ON_CHAIN,
      help: ['--proof-server <url>          Proof server endpoint'],
      agent: ENDPOINT_PARAMS['proof-server'],
    },
  ],
  help: {
    description: 'Inspect, deploy, call, and query Midnight smart contracts',
    usage: 'midnight contract <inspect|deploy|call|state> [options]',
    flags: [
      'inspect                       Show circuits, witnesses, and types',
      'deploy                        Deploy a contract to the network',
      'call                          Call a circuit on a deployed contract',
      'state                         Read ledger state of a deployed contract',
      { flag: 'address' },
      { flag: 'circuit' },
      { flag: 'args' },
      { flag: 'network' },
      { flag: 'path' },
      { flag: 'managed' },
      { flag: 'name' },
      { flag: 'wallet' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'proof-server' },
      { flag: 'secret-key' },
      '--json                        Output structured JSON',
    ],
    examples: [
      'midnight contract inspect',
      'midnight contract deploy',
      'midnight contract deploy --args \'{"deadlineSecs": 300}\'',
      'midnight contract call --address 0x123 --circuit submit_score --args \'{"score": 100, "alias": "TEST"}\'',
      'midnight contract state --address 0x123',
      'midnight contract deploy --json',
    ],
    jsonFields: {
      name: 'Contract name',
      address: 'Deployed contract address (deploy, call)',
      compilerVersion: 'Compact compiler version (inspect)',
      circuits: 'Array of circuit definitions (inspect)',
      witnesses: 'Array of witness definitions (inspect)',
      state: 'Contract ledger state (state)',
    },
  },
  intro: { brief: 'Inspect, deploy, call contracts', order: 10 },
  needsWalletSdk: true,
  shell: { payer: true },
  load: () => import('./contract.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_contract_inspect',
        description: 'Inspect a compiled Compact contract: name, circuits (with arg/return types), witnesses, compiler/language/runtime versions. Reads managed/<name>/compiler/contract-info.json under the dapp dir. Returns a `siblings` array listing other contracts in the same project — call again with `name` to inspect a sibling.',
        annotations: { readOnlyHint: true, idempotentHint: true },
        // As this tool showed them before tool schemas came from the flags.
        params: [
          { flag: 'path', schema: { type: 'string', description: 'Path to dApp directory (defaults to cwd)' } },
          { flag: 'managed', schema: { type: 'string', description: 'Direct path to a managed/<name>/ directory (overrides path)' } },
          {
            flag: 'name',
            schema: { type: 'string', description: 'Specific contract name to inspect when the project has multiple (see siblings field)' },
          },
        ],
        argv: { subcommand: 'inspect', flags: 'rest' },
        order: 24,
      },
      {
        name: 'midnight_contract_state',
        description: 'Read the current ledger state of a deployed contract. Returns the ledger fields as a JSON object.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [
          { flag: 'address' },
          { flag: 'wallet' },
          { flag: 'network' },
          {
            // As this tool showed it before tool schemas came from the flags.
            flag: 'path',
            schema: { type: 'string', description: 'dApp directory (defaults to cwd; needed to find the compiled artifact for state decoding)' },
          },
          { flag: 'managed' },
          { flag: 'name' },
        ],
        required: ['address'],
        argv: { subcommand: 'state', flags: 'rest' },
        order: 25,
      },
      {
        name: 'midnight_contract_deploy',
        description: 'Deploy a compiled Compact contract (returns pending token; agent must show the description and redeem via midnight_confirm_operation).',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { flag: 'wallet' },
          { flag: 'network' },
          // As this tool showed it before tool schemas came from the flags.
          { flag: 'args', schema: { type: 'string', description: 'JSON-encoded array or object of constructor arguments' } },
          { flag: 'path' },
          { flag: 'managed' },
          { flag: 'name' },
        ],
        argv: { subcommand: 'deploy', flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            const argsHint = params.args ? ` with args ${params.args}` : '';
            return `Deploy contract from ${params.path ?? 'current directory'} as ${wallet} on ${network}${argsHint}`;
          },
          async check(params, call) {
            const { resolveContractDeployRequest } = await import('../lib/contract/request.ts');
            resolveContractDeployRequest(call.argv());
            await checkSendingWallet(params);
          },
        },
        order: 26,
      },
      {
        name: 'midnight_contract_call',
        description: 'Call a circuit on a deployed contract (returns pending token; agent must show the description and redeem via midnight_confirm_operation).',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { flag: 'address' },
          { flag: 'circuit' },
          { flag: 'wallet' },
          { flag: 'network' },
          { flag: 'args' },
          { flag: 'path' },
          { flag: 'managed' },
          { flag: 'name' },
        ],
        required: ['address', 'circuit'],
        argv: { subcommand: 'call', flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            const argsHint = params.args ? ` with args ${params.args}` : '';
            return `Call circuit ${params.circuit} on contract ${params.address} as ${wallet} on ${network}${argsHint}`;
          },
          async check(params, call) {
            const { resolveContractCallRequest } = await import('../lib/contract/request.ts');
            resolveContractCallRequest(call.argv());
            await checkSendingWallet(params);
          },
        },
        order: 27,
      },
    ],
  },
};
