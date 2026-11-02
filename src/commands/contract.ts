// Contract commands — inspect, deploy, call, and query state for compiled Midnight contracts.

import { resolve } from 'node:path';
import { type ParsedArgs, getFlag, hasFlag, requireFlag } from '../lib/argv.ts';
import { CancelledError, UsageError, throwIfCancelled } from '../lib/errors.ts';
import { untilCancelled } from '../lib/sleep.ts';
import type { CallContext, CallOutput } from '../lib/call-context.ts';
import { header, keyValue } from '../ui/format.ts';
import { bold, dim, teal, yellow, green } from '../ui/colors.ts';

import { type Payer, payerFor, resolvePayingTarget } from '../lib/payer.ts';
import { deployContract } from '../lib/contract/deploy.ts';
import { callContract } from '../lib/contract/call.ts';
import { validateContractAddress } from '../lib/contract/validate.ts';
import { engineFor, type RawStateValue } from '../lib/engine.ts';
import { resolveContractCallRequest, resolveContractDeployRequest, resolveScanDir } from '../lib/contract/request.ts';
import {
  findContractInfo,
  formatCircuitSignature,
  formatCircuitFlags,
  formatWitnessSignature,
  toJsonOutput,
} from '../lib/contract/inspect.ts';

const VALID_SUBCOMMANDS = ['inspect', 'deploy', 'call', 'state'] as const;
type Subcommand = typeof VALID_SUBCOMMANDS[number];

function isValidSubcommand(s: string): s is Subcommand {
  return (VALID_SUBCOMMANDS as readonly string[]).includes(s);
}

export default async function contractCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || !isValidSubcommand(subcommand)) {
    throw new UsageError(
      `Usage: midnight contract <${VALID_SUBCOMMANDS.join('|')}>\n\n` +
      `  inspect   Show circuits, witnesses, and types for a compiled contract\n` +
      `  deploy    Deploy a contract to the network\n` +
      `  call      Call a circuit on a deployed contract\n` +
      `  state     Read the ledger state of a deployed contract\n\n` +
      `Run "midnight help contract" for more info.`
    );
  }

  switch (subcommand) {
    case 'inspect':
      return handleInspect(args, ctx);
    case 'deploy':
      return handleDeploy(args, payerFor('contract deploy', ctx), ctx);
    case 'call':
      return handleCall(args, payerFor('contract call', ctx), ctx);
    case 'state':
      return handleState(args, ctx);
  }
}

// ── Inspect ──

async function handleInspect(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const startDir = resolveScanDir(args);
  const contractName = getFlag(args, 'name');

  const { info } = findContractInfo(startDir, contractName);

  if (jsonMode) {
    ctx.output.result(toJsonOutput(info));
    return;
  }

  ctx.output.stderr('\n' + header(`Contract: ${info.name}`) + '\n\n');
  ctx.output.stderr(keyValue('Compiler', info.compilerVersion) + '\n');
  ctx.output.stderr(keyValue('Language', info.languageVersion) + '\n');
  ctx.output.stderr(keyValue('Runtime', info.runtimeVersion) + '\n');

  ctx.output.stderr('\n' + bold('  Circuits') + '\n');
  if (info.circuits.length === 0) {
    ctx.output.stderr(dim('    (none)') + '\n');
  } else {
    for (const circuit of info.circuits) {
      const sig = formatCircuitSignature(circuit);
      const flags = formatCircuitFlags(circuit);
      const flagColor = circuit.pure ? teal(flags) : yellow(flags);
      ctx.output.stderr(`    ${sig}  ${dim('—')} ${flagColor}\n`);
    }
  }

  ctx.output.stderr('\n' + bold('  Witnesses') + '\n');
  if (info.witnesses.length === 0) {
    ctx.output.stderr(dim('    (none)') + '\n');
  } else {
    for (const witness of info.witnesses) {
      ctx.output.stderr(`    ${formatWitnessSignature(witness)}\n`);
    }
  }

  if (info.siblings.length > 0) {
    ctx.output.stderr('\n' + bold('  Other contracts in this project') + '\n');
    for (const name of info.siblings) {
      ctx.output.stderr(`    ${teal(name)}\n`);
    }
    ctx.output.stderr('\n' + dim('  Inspect a sibling: mn contract inspect --name <name>') + '\n');
  }

  ctx.output.stderr('\n');
}

// ── Deploy ──

async function handleDeploy(args: ParsedArgs, payer: Payer, ctx: CallContext): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const request = resolveContractDeployRequest(args);
  const { info, constructorArgs } = request;

  if (!jsonMode) {
    ctx.output.stderr('\n' + header('Contract Deploy') + '\n\n');
  }

  const target = resolvePayingTarget(args, 'contract', 'deploy');
  const { network } = target;

  if (!jsonMode) {
    ctx.output.stderr(keyValue('Contract', info.name) + '\n');
    ctx.output.stderr(keyValue('Network', network) + '\n');
    if (constructorArgs.length > 0) {
      ctx.output.stderr(keyValue('Constructor args', String(constructorArgs.length)) + '\n');
    }
    ctx.output.stderr('\n');
  }

  const deployed = await deployContract({
    request,
    target,
    wallet: getFlag(args, 'wallet'),
    payer,
    progress: (message) => jsonMode ? ctx.progress.silent() : ctx.progress.start(message),
    sdkWarnings: ctx.sdkWarnings,
    signal: ctx.signal,
  });

  if (jsonMode) {
    // JSON path emits a single line of structured output on stdout. The
    // bare address line below is for the human "pipe through head" workflow
    // and would pollute the JSON stream.
    ctx.output.result({
      subcommand: 'deploy',
      contractName: deployed.contractName,
      address: deployed.address,
      network,
    });
  } else {
    ctx.output.stderr('\n');
    ctx.output.stderr(keyValue('Address', deployed.address) + '\n');
    ctx.output.stderr('\n' + green('  ✓ Deploy successful') + '\n');
    writeNextStepsHint(ctx.output, deployed.address, info.circuits, network);
    // Pipeable address on stdout for shell composition (e.g. `addr=$(mn contract deploy)`).
    ctx.output.stdout(deployed.address + '\n');
  }
}

/**
 * Print "what next?" hints after a successful deploy. Always shows the
 * state-read command (works even for contracts with no public circuits),
 * and adds a call command when at least one circuit takes no arguments
 * (those run as-is without --args).
 */
function writeNextStepsHint(output: CallOutput, address: string, circuits: { name: string; arguments: unknown[] }[], network: string): void {
  const networkFlag = network === 'undeployed' ? '' : ` --network ${network}`;
  output.stderr('\n' + dim('  Next:') + '\n');
  output.stderr(dim('    mn contract state --address ') + teal(address) + dim(networkFlag) + '\n');
  const noArgCircuit = circuits.find((c) => c.arguments.length === 0);
  if (noArgCircuit) {
    output.stderr(
      dim('    mn contract call --address ') + teal(address) +
      dim(' --circuit ') + teal(noArgCircuit.name) + dim(networkFlag) + '\n',
    );
  }
  output.stderr('\n');
}

// ── Call ──

async function handleCall(args: ParsedArgs, payer: Payer, ctx: CallContext): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const request = resolveContractCallRequest(args);
  const { info, address, circuit } = request;

  if (!jsonMode) {
    ctx.output.stderr('\n' + header('Contract Call') + '\n\n');
  }

  const target = resolvePayingTarget(args, 'contract', 'call');
  const { network } = target;

  if (!jsonMode) {
    ctx.output.stderr(keyValue('Contract', info.name) + '\n');
    ctx.output.stderr(keyValue('Circuit', circuit) + '\n');
    ctx.output.stderr(keyValue('Address', address.slice(0, 20) + '...') + '\n\n');
  }

  const called = await callContract({
    request,
    target,
    wallet: getFlag(args, 'wallet'),
    payer,
    progress: (message) => jsonMode ? ctx.progress.silent() : ctx.progress.start(message),
    sdkWarnings: ctx.sdkWarnings,
    signal: ctx.signal,
  });

  if (jsonMode) {
    ctx.output.result({
      subcommand: 'call',
      contractName: called.contractName,
      circuit,
      address,
      network,
      status: called.status,
    });
  } else {
    ctx.output.stderr('\n' + green('  ✓ Circuit call successful') + '\n\n');
  }
}

// ── State ──

async function handleState(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const dappDir = resolve(getFlag(args, 'path') ?? process.cwd());
  const scanDir = resolveScanDir(args);
  const contractName = getFlag(args, 'name');
  const address = requireFlag(args, 'address', 'contract address');
  validateContractAddress(address);

  const { runState } = await import('../lib/contract/runner.ts');

  const { network, networkConfig } = resolvePayingTarget(args, 'contract', 'state');

  if (!jsonMode) {
    ctx.output.stderr('\n' + header('Contract State') + '\n\n');
    ctx.output.stderr(keyValue('Address', address.slice(0, 20) + '...') + '\n');
    ctx.output.stderr(keyValue('Network', network) + '\n\n');
  }

  // Try parsed ledger state via runner (needs compiled contract in dApp)
  const spinner = jsonMode ? ctx.progress.silent() : ctx.progress.start('Querying contract state...');

  try {
    const { info } = findContractInfo(scanDir, contractName);

    const result = await runState({
      dappDir,
      network,
      networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      contractAddress: address,
      onMessage: (msg) => spinner.update(msg),
      signal: ctx.signal,
    });

    spinner.stop('State retrieved');

    if (jsonMode) {
      ctx.output.result({
        subcommand: 'state',
        address,
        network,
        ...result,
      });
    } else {
      // Display scalar fields
      const hasFields = Object.keys(result.fields).length > 0;
      const hasMaps = Object.keys(result.maps).length > 0;

      if (hasFields || hasMaps) {
        ctx.output.stderr(bold('  Ledger State') + '\n');
        for (const [key, value] of Object.entries(result.fields)) {
          ctx.output.stderr(`    ${key}: ${teal(value)}` + '\n');
        }
        for (const [key, info] of Object.entries(result.maps)) {
          ctx.output.stderr(`    ${key}: ${dim(`Map (${(info as any).size} entries)`)}` + '\n');
        }
      } else {
        ctx.output.stderr(dim('  (no ledger fields found)') + '\n');
      }
      ctx.output.stderr('\n');
    }
  } catch (err) {
    // A cancelled call stops here; it doesn't fall back to the raw state.
    if (err instanceof CancelledError) throw err;
    throwIfCancelled(ctx.signal);
    // If runner fails (no compiled contract in cwd), fall back to raw state
    spinner.stop(yellow('⚠') + ' Parsed state unavailable, showing raw');

    // The engine's query takes no signal: the call stops waiting for it when cancelled.
    const raw = await untilCancelled((await engineFor(network)).contracts.rawState(networkConfig, address), ctx.signal);

    if (!raw) {
      throw new Error(`No contract found at address ${address} on ${network}`);
    }

    if (jsonMode) {
      ctx.output.result({ subcommand: 'state', address, network, raw });
    } else {
      ctx.output.stderr(bold('  Raw State') + '\n');
      ctx.output.stderr(dim('    (run from dApp root for parsed ledger fields)') + '\n');
      for (const line of rawStateLines(raw, '    ')) ctx.output.stderr(line + '\n');
      ctx.output.stderr('\n');
    }
  }
}

/** The untyped state as indented lines: an array's items by index, a cell's bytes in hex. */
function rawStateLines(value: RawStateValue, indent: string): string[] {
  switch (value.type) {
    case 'null':
      return [indent + dim('null')];
    case 'cell':
      return [indent + 'cell ' + teal(value.value.map((atom) => '0x' + atom).join(' '))];
    case 'map':
      return [indent + dim(`Map (${value.size} entries)`)];
    case 'boundedMerkleTree':
      return [indent + dim(`Merkle tree (height ${value.height}, root ${value.root === null ? 'none' : '0x' + value.root.join('')})`)];
    case 'array':
      return value.items.flatMap((item, i) => {
        const lines = rawStateLines(item, indent + '  ');
        return item.type === 'array' ? [indent + `[${i}]`, ...lines] : [indent + `[${i}] ` + lines[0]!.trimStart()];
      });
  }
}
