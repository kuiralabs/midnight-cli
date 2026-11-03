// localnet command — manage local Midnight network via Docker Compose
// Subcommands: up, down, status, logs

import { spawn } from 'child_process';
import { type ParsedArgs, hasFlag, getFlag } from '@kuiralabs/midnight-cli-core/lib/argv';
import { CancelledError, UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { execProgram, ProgramFailedError, type ExecRunner } from '@kuiralabs/midnight-cli-core/lib/exec-program';
import {
  assertLocalnetCanStart,
  checkDockerAvailable,
  ensureComposeFile,
  dockerCompose,
  getServiceStatus,
  getComposePath,
  localnetUpCancelled,
  removeConflictingContainers,
  startLocalnet,
  type DockerCall,
  type ServiceStatus,
} from '../lib/localnet.ts';
import { header, divider } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, green, red, dim, yellow } from '@kuiralabs/midnight-cli-core/ui/colors';

import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';

const VALID_SUBCOMMANDS = ['up', 'stop', 'down', 'status', 'logs', 'clean'] as const;
type Subcommand = typeof VALID_SUBCOMMANDS[number];

function isValidSubcommand(s: string): s is Subcommand {
  return (VALID_SUBCOMMANDS as readonly string[]).includes(s);
}

function formatServiceTable(services: readonly ServiceStatus[]): string {
  const lines: string[] = [];
  for (const svc of services) {
    const stateColor = svc.state === 'running' ? green : red;
    const healthStr = svc.health ? ` (${svc.health})` : '';
    const portStr = svc.port ? `:${svc.port}` : '';
    const imageStr = svc.image ? `  ${dim(svc.image)}` : '';
    lines.push(`  ${svc.name.padEnd(16)}${stateColor(svc.state)}${dim(healthStr)}${dim(portStr)}`);
    if (imageStr) lines.push(imageStr);
  }
  return lines.join('\n');
}

async function handleUp(jsonMode: boolean, ctx: CallContext, docker: DockerCall): Promise<void> {
  const wrote = ensureComposeFile(docker.root);
  if (wrote) {
    ctx.output.stderr(dim(`  Wrote compose.yml to ${getComposePath(docker.root)}`) + '\n');
  }

  const spinner = ctx.progress.start('Starting local network...');

  try {
    const healthy = await startLocalnet(docker, (status) => spinner.update(status), 120_000);

    if (!healthy) {
      spinner.stop(yellow('Services started but not all healthy yet'));
      ctx.output.stderr('\n' + dim('  Tip: run ') + bold('midnight localnet logs') + dim(' to check for errors') + '\n');
    } else {
      // Docker healthy ≠ chain ready. Layered waits:
      //  1. Node has produced block 1 (substrate chain_getHeader).
      //  2. Indexer has ingested genesis state (non-zero UTXOs for genesis
      //     via GraphQL), so subsequent balance/sync calls see the funds.
      //  3. Proof server responds on its HTTP root. The proof-server container
      //     has no Docker healthcheck, so it can report "running" while still
      //     warming up — an immediately-following transfer then fails at
      //     prove time with "Failed to prove transaction".
      spinner.update('Waiting for chain to produce first block...');
      try {
        const { waitForFirstBlock } = await import('@kuiralabs/midnight-chain/lib/node-ready');
        const { waitForAddressFunded } = await import('@kuiralabs/midnight-chain/lib/indexer-ready');
        const { waitForProofServerReady } = await import('@kuiralabs/midnight-chain/lib/proof-server-ready');
        const { getNetworkConfig } = await import('@kuiralabs/midnight-cli-core/lib/network');
        const { GENESIS_SEED } = await import('@kuiralabs/midnight-cli-core/lib/constants');

        const netCfg = getNetworkConfig('undeployed');
        await waitForFirstBlock(netCfg.node, { timeoutMs: 30_000, signal: ctx.signal });

        spinner.update('Waiting for indexer to ingest genesis state...');
        const genesisAddress = (await ctx.host.engines.for('undeployed')).keys.unshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
        await waitForAddressFunded(netCfg.indexerWS, genesisAddress, { timeoutMs: 30_000, signal: ctx.signal });

        spinner.update('Waiting for proof server...');
        await waitForProofServerReady(netCfg.proofServer, { timeoutMs: 30_000, signal: ctx.signal });

        spinner.stop('Local network is running');
      } catch (err) {
        if (ctx.signal.aborted) throw await localnetUpCancelled(docker);
        spinner.stop(yellow('Services running but chain/indexer/proof-server not fully ready yet'));
        ctx.output.stderr('\n' + dim('  Tip: give it a few more seconds then retry. Run ') + bold('midnight localnet logs') + dim(' if this persists.') + '\n');
      }
    }
  } catch (err) {
    // Cancelled: the containers already started stay in place, and the error says which.
    if (err instanceof CancelledError) {
      spinner.fail('Cancelled: containers already started stay in place');
      throw err;
    }
    spinner.fail('Failed to start local network');
    if (err instanceof Error) {
      if (err.message.includes('is already in use by container')) {
        throw new Error(
          'Container name conflict — containers with the same names already exist.\n\n' +
          'If an earlier mn localnet created them, "midnight localnet clean" removes them;\n' +
          'it leaves containers from anything else alone and lists them.'
        );
      }
      if (err.message.includes('address already in use')) {
        throw new Error(
          'Port conflict detected — another process is using a required port.\n' +
          'Check ports 9944, 8088, and 6300, then try again.'
        );
      }
    }
    throw err;
  }

  // Show status table
  const services = await getServiceStatus(docker);

  if (jsonMode) {
    ctx.output.result({
      subcommand: 'up',
      services: services.map(s => ({ name: s.name, state: s.state, port: s.port, health: s.health, image: s.image })),
    });
    return;
  }

  if (services.length > 0) {
    ctx.output.stderr('\n' + formatServiceTable(services) + '\n');
  }

  // Machine-readable output to stdout
  for (const svc of services) {
    ctx.output.stdout(`${svc.name}=${svc.state}:${svc.port}\n`);
  }

  ctx.output.stderr('\n' + dim('  Next: ') + bold('midnight wallet generate dev --network undeployed') + '\n');
}

async function handleStop(jsonMode: boolean, ctx: CallContext, docker: DockerCall): Promise<void> {
  const spinner = ctx.progress.start('Stopping local network...');

  try {
    await dockerCompose(docker, ['stop']);
    spinner.stop('Local network stopped (containers preserved)');
    if (jsonMode) {
      ctx.output.result({ subcommand: 'stop', status: 'stopped' });
      return;
    }
  } catch (err) {
    spinner.fail('Failed to stop local network');
    throw err;
  }
}

async function handleDown(jsonMode: boolean, ctx: CallContext, docker: DockerCall): Promise<void> {
  const spinner = ctx.progress.start('Tearing down local network...');

  try {
    await dockerCompose(docker, ['down', '--volumes']);
    // Wipe every cache keyed to the undeployed chain — the volumes just got
    // removed, so any wallet cache still referencing it is guaranteed stale
    // and would trigger "applied > highest" on the next command. Clearing
    // here means the next `mn <anything>` starts with a truthful cache.
    const { clearChainCaches } = await import('../lib/chain-caches.ts');
    clearChainCaches('undeployed', docker.root);

    // Also wipe the dapp-local LevelDB private-state store if the user is
    // running this from a dapp directory. The store survives `docker compose
    // down --volumes` and refers to contract addresses that no longer exist
    // after the chain reset, causing "NotOpenError: Database failed to open"
    // (corruption) on the next `mn contract deploy/call`. Best-effort: only
    // touches the store in the cwd, never scans the filesystem.
    const { PRIVATE_STATE_DATABASE, clearDappPrivateState } = await import('../lib/contract/private-state.ts');
    const leveldbWiped = clearDappPrivateState(process.cwd());

    spinner.stop('Local network removed (containers, networks, volumes, caches)');
    if (jsonMode) {
      ctx.output.result({ subcommand: 'down', status: 'removed', cachesCleared: true, dappLevelDbWiped: leveldbWiped });
      return;
    }
    if (leveldbWiped) {
      ctx.output.stderr(dim(`  Also cleared dapp leveldb at ./${PRIVATE_STATE_DATABASE} (private state from old chain)`) + '\n');
    }
  } catch (err) {
    spinner.fail('Failed to tear down local network');
    throw err;
  }
}

async function handleStatus(jsonMode: boolean, ctx: CallContext, docker: DockerCall): Promise<void> {
  const services = await getServiceStatus(docker);

  if (jsonMode) {
    ctx.output.result({
      subcommand: 'status',
      services: services.map(s => ({ name: s.name, state: s.state, port: s.port, health: s.health, image: s.image })),
    });
    return;
  }

  if (services.length === 0) {
    ctx.output.stderr('\n' + header('Localnet Status') + '\n\n');
    ctx.output.stderr(dim('  No services running.') + '\n');
    ctx.output.stderr(dim('  ') + bold('midnight localnet up') + dim(' is refused on this ledger-9 build; see ') + bold('midnight help localnet') + dim('.') + '\n\n');
    return;
  }

  ctx.output.stderr('\n' + header('Localnet Status') + '\n\n');
  ctx.output.stderr(formatServiceTable(services) + '\n');
  ctx.output.stderr('\n' + divider() + '\n\n');

  // Machine-readable output to stdout
  for (const svc of services) {
    ctx.output.stdout(`${svc.name}=${svc.state}:${svc.port}\n`);
  }
}

async function handleClean(jsonMode: boolean, ctx: CallContext, docker: DockerCall): Promise<void> {
  const spinner = ctx.progress.start('Removing conflicting containers...');

  try {
    // First try compose down to clean up any compose-managed resources
    try { await dockerCompose(docker, ['down']); } catch (err) { if (err instanceof CancelledError) throw err; /* may fail if compose file doesn't match */ }

    // Remove containers with mn's names that mn's compose project created
    const { removed, kept } = await removeConflictingContainers(docker);

    if (removed.length > 0) {
      spinner.stop(`Removed ${removed.length} container${removed.length > 1 ? 's' : ''}: ${removed.join(', ')}`);
    } else {
      spinner.stop('No conflicting containers found');
    }
    if (jsonMode) {
      ctx.output.result({ subcommand: 'clean', status: 'cleaned', removed, kept });
      return;
    }
    for (const c of kept) {
      ctx.output.stderr(dim(`  Left "${c.name}" alone: it belongs to ${c.project ? `compose project "${c.project}"` : 'no compose project'}, not mn's localnet. Remove it yourself if it is in the way.`) + '\n');
    }
  } catch (err) {
    spinner.fail('Failed to clean up');
    throw err;
  }
}

async function handleLogs(args: ParsedArgs, ctx: CallContext, docker: DockerCall): Promise<void> {
  const composePath = getComposePath(docker.root);
  const tail = getFlag(args, 'tail');
  const jsonMode = hasFlag(args, 'json');

  // --tail N (or --json) → finite snapshot, no streaming. Required by MCP.
  if (tail !== undefined || jsonMode) {
    const n = tail ?? '200';
    let stdout: string;
    try {
      // Its stderr is kept for the error, not shown.
      stdout = await docker.exec('docker', ['compose', '-f', composePath, 'logs', '--tail', n, '--no-color'], { signal: ctx.signal });
    } catch (err) {
      if (!(err instanceof ProgramFailedError)) throw err;
      if (err.exitCode !== null) throw new Error(`docker compose logs exited with code ${err.exitCode}: ${err.stderr.trim()}`);
      // Killed by a signal from elsewhere: what it printed stands, as it always has.
      stdout = err.stdout;
    }
    if (jsonMode) {
      ctx.output.result({ tail: Number(n), lines: stdout.split('\n').filter(Boolean) });
    } else {
      ctx.output.stdout(stdout);
    }
    return;
  }

  // Default: stream logs directly to terminal via spawn with inherited stdio
  const child = spawn('docker', ['compose', '-f', composePath, 'logs', '-f'], {
    stdio: 'inherit',
  });
  // Following ends when the call is cancelled (Ctrl+C), its normal end: the client is killed and the command ends as before.
  const stopFollowing = (): void => { child.kill(); };
  ctx.signal.addEventListener('abort', stopFollowing, { once: true });

  // Wait for the child to exit (user will Ctrl+C)
  return new Promise<void>((resolve, reject) => {
    child.on('exit', () => ctx.signal.removeEventListener('abort', stopFollowing));
    child.on('close', (code) => {
      // Exit code 130 = SIGINT (Ctrl+C), which is normal
      if (code === 0 || code === 130 || code === null) {
        resolve();
      } else {
        reject(new Error(`docker compose logs exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

export default async function localnetCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  return runLocalnet(args, ctx, execProgram);
}

/** The command, with the runner its Docker commands go through (tests give one that runs no Docker). */
export async function runLocalnet(args: ParsedArgs, ctx: CallContext, exec: ExecRunner): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || !isValidSubcommand(subcommand)) {
    throw new UsageError(
      `Usage: midnight localnet <${VALID_SUBCOMMANDS.join('|')}>\n\n` +
      `Subcommands:\n` +
      `  up        Start the local network (refused on this ledger-9 build)\n` +
      `  stop      Stop containers (preserves state)\n` +
      `  down      Remove containers, networks, volumes\n` +
      `  status    Show service status\n` +
      `  logs      Stream service logs\n` +
      `  clean     Remove conflicting containers\n\n` +
      `Example: midnight localnet status`
    );
  }

  // `up` is refused on this build whatever Docker's state: say that, not "install Docker".
  if (subcommand === 'up') assertLocalnetCanStart();

  // Docker runs as a step of this call: its stderr goes where the call's text goes, and the call's cancellation kills it.
  const docker: DockerCall = { signal: ctx.signal, exec, onStderr: (text) => ctx.output.stderr(text), root: ctx.config.paths.stateRoot };

  // Check Docker is available before any operation
  await checkDockerAvailable(docker);

  const jsonMode = hasFlag(args, 'json');

  ctx.output.stderr('\n' + header('Localnet') + '\n\n');

  switch (subcommand) {
    case 'up':
      return handleUp(jsonMode, ctx, docker);
    case 'stop':
      return handleStop(jsonMode, ctx, docker);
    case 'down':
      return handleDown(jsonMode, ctx, docker);
    case 'status':
      return handleStatus(jsonMode, ctx, docker);
    case 'logs':
      return handleLogs(args, ctx, docker);
    case 'clean':
      return handleClean(jsonMode, ctx, docker);
  }
}
