// The `contract` command, described once.

import { type CommandDefinition, ENDPOINT_PARAMS, NETWORK_PARAM, confirmationTarget, type HostEngines } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { OPENS_WALLET } from '@kuiralabs/midnight-wallet/commands';
import { RUNS_CONTRACTS } from './contract.codes.ts';
import type { ContractCostJson } from '../lib/contract/cost.ts';

/** The subcommands that reach a chain: inspect reads only the compiled contract (--path, --managed, --name). */
const ON_CHAIN: readonly string[] = ['deploy', 'call', 'state'];

/** The wallet a deploy or call pays from, under the state root `root`, exists and can be read (with the host's `engines`). */
async function checkSendingWallet(params: Readonly<Record<string, unknown>>, root: string, engines: HostEngines): Promise<void> {
  const { loadWalletConfig, resolveWalletPath } = await import('@kuiralabs/midnight-wallet');
  await loadWalletConfig(resolveWalletPath(root, params.wallet as string | undefined), engines);
}

/**
 * How a confirmation names the arguments a deploy or call is given: that they
 * were given and how, never what they are. A circuit's arguments are private
 * inputs to its proof, and the confirmation is text the agent and its host
 * keep.
 */
export function describeGivenArgs(params: Readonly<Record<string, unknown>>, what: string): string {
  if (typeof params['args-file'] === 'string' && params['args-file'] !== '') return ` with ${what} from the file ${params['args-file']}`;
  if (params.args !== undefined && params.args !== '') return ` with ${what} (given, not shown)`;
  return '';
}

/** What a deploy confirmation names: the dApp, the wallet, the network, and whether constructor arguments were given (never their values). */
function describeDeploy(params: Readonly<Record<string, unknown>>): string {
  const { network, wallet } = confirmationTarget(params);
  return `Deploy contract from ${params.path ?? 'current directory'} as ${wallet} on ${network}${describeGivenArgs(params, 'constructor arguments')}`;
}

/** What a call confirmation names: the circuit, the contract, the wallet, the network, and whether arguments were given (never their values). */
function describeCall(params: Readonly<Record<string, unknown>>): string {
  const { network, wallet } = confirmationTarget(params);
  return `Call circuit ${params.circuit} on contract ${params.address} as ${wallet} on ${network}${describeGivenArgs(params, 'arguments')}`;
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
        '--args \'<json>\'               JSON arguments, for public values only: constructor args (deploy) or circuit args (call), an array in order or an object read by its values in order (its keys are not matched to parameter names: list them in the circuit\'s order). Numbers auto-coerce to BigInt; "123n" strings parse as BigInt; arrays of 0–255 ints become Uint8Array. On the command line they are in ps and the shell\'s history: a circuit\'s arguments are private inputs to its proof, so give private ones with --args-file or --args -, and mn warns when it sees a circuit keep one private',
        '--args -                      Read the JSON arguments from the standard input (deploy, call): echo \'{"bid": 5}\' | mn contract call ... --args -',
        '"@coin" in the arguments      {"@coin": {"amount": "3", "token": "NIGHT"}} is a fresh shielded coin, anywhere the circuit takes a ShieldedCoinInfo (call): mn makes a random nonce, the token\'s colour (NIGHT, or a raw type as 64 hex) and the value in its smallest unit (a NIGHT amount has up to 6 decimals; another token\'s is a whole number of its smallest unit). The result gives each fresh coin\'s nonce (freshCoins)',
      ],
      agent: { type: 'string', description: 'JSON-encoded array or object of circuit arguments (an object is read by its values in order, not by key: list its keys in the circuit\'s parameter order), for public values: the confirmation and results never repeat them, but they are text in the tool call. Give private ones (a bid, a vote, a coin\'s nonce) with args-file. {"@coin": {"amount": "3", "token": "NIGHT"}} stands for a fresh shielded coin wherever the circuit takes a ShieldedCoinInfo; the result gives its nonce (freshCoins)' },
    },
    {
      name: 'args-file',
      takesValue: true,
      subcommands: ['deploy', 'call'],
      help: [
        '--args-file <path>            Read the JSON arguments from a file (deploy, call), for private values: they stay off the command line. The contract script gets them through a 0600 file under ~/.midnight/contract-args/ that is deleted when it ends; no argument is ever written into the dApp\'s folder',
      ],
      agent: { type: 'string', description: 'Path of a JSON file of the arguments (an array, or an object in the circuit\'s order): for private values, which then never appear in the tool call. Not with args' },
    },
    {
      name: 'circuit',
      takesValue: true,
      subcommands: ['call'],
      help: ['--circuit <name>              Circuit to call (call)'],
      agent: { type: 'string', description: 'Circuit name to invoke' },
    },
    {
      name: 'dry-run',
      takesValue: false,
      subcommands: ['deploy', 'call'],
      help: [
        '--dry-run                     Price the deploy or call and stop (deploy, call): the wallet syncs and the contract script builds the transaction, and nothing is proven or sent',
      ],
      agent: { notForAgents: 'the deploy tool\'s confirmation prices the deploy itself and shows the cost; confirming then deploys' },
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
      help: ['--network <name>              Network (default: the one set with config set network, else undeployed)'],
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
      subcommands: ['deploy', 'call'],
      help: [
        '--secret-key <64-hex>         The private-state secret (deploy, call), for a contract whose owner is public_key(secret_key()). Default: one derived from the wallet\'s seed, the same on every run. It reaches the contract script through its environment, never argv; the private state it seeds is kept under mn\'s state root (~/.midnight/contract-state/<network>/<address>/, one store per contract, owner-only), encrypted with a key derived from the wallet\'s seed. A call starts from the private state stored for the contract (what the last call\'s witnesses left), so on call the secret seeds it only when none is stored yet',
        '--secret-key legacy           (call) The secret an mn before 0.6.0 used by default: the wallet\'s public coin key. Only for calling a contract deployed with that default',
      ],
      agent: {
        type: 'string',
        description: 'The private-state secret, 64 hex chars, for a contract whose owner is public_key(secret_key()); by default one derived from the wallet\'s seed. On call, "legacy" uses the default of an mn before 0.6.0 (the wallet\'s public coin key) for a contract deployed with it. The private state it seeds is kept under mn\'s state root, one store per contract (~/.midnight/contract-state/<network>/<address>/), encrypted with a key from the wallet\'s seed',
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
      { flag: 'args-file' },
      { flag: 'network' },
      { flag: 'path' },
      { flag: 'managed' },
      { flag: 'name' },
      { flag: 'wallet' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'proof-server' },
      { flag: 'secret-key' },
      { flag: 'dry-run' },
      '--json                        Output structured JSON',
      'A deploy or call says its cost after the wallet syncs and before anything is proven: the expected fee at the chain\'s fee prices now, the Dust the wallet commits to it (the fee with its margin of rising prices, all of it burned), and whether the wallet\'s Dust covers that or how long its registered NIGHT takes to',
    ],
    examples: [
      'midnight contract inspect',
      'midnight contract deploy',
      'midnight contract deploy --args \'{"deadlineSecs": 300}\'',
      'midnight contract call --address 0x123 --circuit submit_score --args \'{"score": 100, "alias": "TEST"}\'',
      'midnight contract call --address 0x123 --circuit bid --args-file bid.json',
      'echo \'{"vote": 1}\' | midnight contract call --address 0x123 --circuit vote --args -',
      'midnight contract call --address 0x123 --circuit lock --args \'{"coin": {"@coin": {"amount": "3", "token": "NIGHT"}}, "unlock": 1794378400}\'',
      'midnight contract state --address 0x123',
      'midnight contract deploy --json',
      'midnight contract deploy --dry-run',
      'midnight contract call --address 0x123 --circuit increment --dry-run --json',
    ],
    jsonFields: {
      subcommand: 'deploy, call or state (not inspect)',
      name: 'Contract name (inspect)',
      contractName: 'Contract name (deploy, call)',
      address: 'Contract address (deploy, call, state)',
      network: 'Network (deploy, call, state)',
      txHash: 'Hash of the deploy\'s or call\'s transaction (deploy, call)',
      receipt: 'The transaction once the indexer lists it: block, time, fee, result; null with receiptMissing saying why (deploy, call)',
      circuit: 'Circuit called (call)',
      status: 'What the call reported (call)',
      cost: 'The deploy\'s or call\'s price before it was proven (deploy, call; absent when the mn serve that paid gave none): fee (expected fee at the chain\'s fee prices now, DUST as a decimal string), committed (Dust the wallet commits to it: the fee with its margin, all of it burned), have (Dust the wallet holds), covers (whether have covers committed), waitSeconds (how long its registered NIGHT takes to generate the rest; 0 when it covers, null when not within a day), marginBlocks',
      dryRun: 'true when --dry-run priced the deploy or call and stopped: nothing was proven or sent, and there is no address, txHash or receipt (deploy, call)',
      freshCoins: 'The fresh coins mn made for {"@coin": ...} arguments: [{argument, nonce}], the nonce in hex, by which a contract may name the coin later (call; absent when none)',
      heldCoins: 'The coins the call gave the contract, recorded in its private state under mnHeldCoins (by nonce) for a witness to spend: [{argument, commitment, mtIndex}] (call; absent when none)',
      warnings: 'Notes on the call: --args gave arguments its circuit keeps private, which belong in --args-file or --args - (call)',
      fields: 'Ledger fields, each a string (state)',
      maps: 'Ledger maps, each with its size (state)',
      raw: 'The ledger state undecoded, when the compiled contract is not at hand (state)',
      compilerVersion: 'Compact compiler version (inspect)',
      circuits: 'Array of circuit definitions (inspect)',
      witnesses: 'Array of witness definitions (inspect)',
    },
  },
  intro: { brief: 'Inspect, deploy, call contracts', order: 10 },
  needsWalletSdk: true,
  shell: { payer: true },
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND', RUNS_CONTRACTS, 'NO_PAYER'] },
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
        description: 'Deploy a compiled Compact contract (returns pending token, whose description gives the deploy\'s expected fee, the Dust the wallet commits and whether its Dust covers it, priced after the wallet syncs; agent must show the description and redeem via midnight_confirm_operation).',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { flag: 'wallet' },
          { flag: 'network' },
          // As this tool showed it before tool schemas came from the flags, saying what it is for.
          { flag: 'args', schema: { type: 'string', description: 'JSON-encoded array or object of constructor arguments, for public values: the confirmation and results never repeat them. Give private ones with args-file' } },
          { flag: 'args-file' },
          { flag: 'path' },
          { flag: 'managed' },
          { flag: 'name' },
        ],
        argv: { subcommand: 'deploy', flags: 'rest' },
        confirmation: {
          describe: describeDeploy,
          // The deploy is priced before a token is issued (a dry run: the wallet
          // syncs and the transaction is built, nothing proven or sent), so the
          // user confirms what it costs and whether the wallet's Dust covers it.
          // A price that can't be had (the chain out of reach, a wallet with no
          // NIGHT) is said in its place: the deploy itself says why it fails.
          async check(params, call) {
            const { resolveContractDeployRequest } = await import('../lib/contract/request.ts');
            const args = call.argv();
            const { info } = resolveContractDeployRequest(args, process.cwd());
            const { resolvePayingTarget } = await import('@kuiralabs/midnight-cli-core');
            const { assertContractRunsOn } = await import('../lib/contract/runtime-check.ts');
            const root = call.host.paths().stateRoot;
            await assertContractRunsOn(info, resolvePayingTarget(args, 'contract', 'deploy', root, call.host).network, root, call.host.engines);
            await checkSendingWallet(params, root, call.host.engines);
            const dryRun = call.argv();
            dryRun.flags['dry-run'] = true;
            const { costSentence, unpricedSentence } = await import('../lib/contract/cost.ts');
            const { CancelledError } = await import('@kuiralabs/midnight-cli-core');
            let cost: string;
            try {
              cost = costSentence((await call.run(dryRun)).cost as ContractCostJson);
            } catch (err) {
              if (err instanceof CancelledError) throw err;
              cost = unpricedSentence(err);
            }
            return `${describeDeploy(params)}. ${cost}`;
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
          { flag: 'args-file' },
          { flag: 'path' },
          { flag: 'managed' },
          { flag: 'name' },
        ],
        required: ['address', 'circuit'],
        argv: { subcommand: 'call', flags: 'rest' },
        confirmation: {
          describe: describeCall,
          async check(params, call) {
            const { resolveContractCallRequest } = await import('../lib/contract/request.ts');
            const args = call.argv();
            const { info } = resolveContractCallRequest(args, process.cwd());
            const { resolvePayingTarget } = await import('@kuiralabs/midnight-cli-core');
            const { assertContractRunsOn } = await import('../lib/contract/runtime-check.ts');
            const root = call.host.paths().stateRoot;
            await assertContractRunsOn(info, resolvePayingTarget(args, 'contract', 'call', root, call.host).network, root, call.host.engines);
            await checkSendingWallet(params, root, call.host.engines);
          },
        },
        order: 27,
      },
    ],
  },
};
