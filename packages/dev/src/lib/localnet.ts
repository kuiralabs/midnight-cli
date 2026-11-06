// Localnet management — Docker Compose helpers for midnight-local-network
// Manages a compose.yml at ~/.midnight/localnet/ and runs docker compose:
// asynchronously, as a step of the call that asked, and killed when that call
// is cancelled.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LOCALNET_DIR_NAME, DIR_MODE, CancelledError, CANCELLED_MESSAGE, throwIfCancelled, type ExecRunner, sleep } from '@kuiralabs/midnight-cli-core';

// Version tag — bump when compose content changes so stale files get overwritten
export const COMPOSE_VERSION = '4.0.0';

// Docker image versions: the newest public ledger-9 images, the ones the
// midnight-examples ledger-9 compatibility matrix runs its local network on.
// The node and indexer are pre-releases of the 2.1 and 4.4 lines.
const NODE_IMAGE = 'midnightntwrk/midnight-node:2.1.0-rc.4';
const INDEXER_IMAGE = 'midnightntwrk/indexer-standalone:4.4.0-rc.6';
const PROOF_SERVER_IMAGE = 'midnightntwrk/proof-server:9.0.0';

// Built when used, under the state root the call gives; never when this module loads.
const localnetDir = (root: string): string => join(root, LOCALNET_DIR_NAME);
const composePath = (root: string): string => join(localnetDir(root), 'compose.yml');
const versionPath = (root: string): string => join(localnetDir(root), '.version');

// Full compose.yml for midnight-local-network: the ledger-9 stack above.
export const COMPOSE_YAML = `services:
  proof-server:
    image: '${PROOF_SERVER_IMAGE}'
    container_name: "proof-server"
    command: ['midnight-proof-server', '-v']
    # Self-heal across Docker Desktop restarts and transient stops. Without this,
    # a stopped node/proof-server never comes back while the indexer (below) does,
    # leaving a half-dead localnet: the indexer answers but the node's ws is gone,
    # surfacing downstream as ws "Normal Closure" churn and a wedged dust sync.
    restart: unless-stopped
    ports:
      - "6300:6300"

  indexer:
    image: '${INDEXER_IMAGE}'
    container_name: "indexer"
    # unless-stopped covers two cases: (1) indexer >=4.3.x runs an SPO sub-indexer
    # that queries block #1 at startup and exits the whole process if it isn't there
    # yet — on a fresh chain the node hasn't minted block #1 in the first few seconds,
    # so the first launch loses this race and the restart lets the retry catch up once
    # the node mints block #1 (~6s block time); and (2) Docker Desktop restarts /
    # transient stops, so the whole localnet self-heals (see node + proof-server)
    # instead of going half-dead.
    restart: unless-stopped
    ports:
      - '8088:8088'
    environment:
      RUST_LOG: "indexer=info,chain_indexer=info,indexer_api=info,wallet_indexer=info,indexer_common=info,fastrace_opentelemetry=info,info"
      # Random 32-byte hex-encoded secret used to make the standalone indexer run.
      # Only needed to satisfy the config schema – not meant for secure use.
      APP__INFRA__SECRET: "303132333435363738393031323334353637383930313233343536373839303132"
      APP__INFRA__NODE__URL: "ws://node:9944"
      # indexer >=4.3.x added a separate SPO poller. Point it at our node
      # (defaults to localhost, which is the indexer container itself), and
      # satisfy the now-required blockfrost_id with a placeholder — SPO/staking
      # features aren't exercised on localnet, and any non-empty value loads.
      APP__INFRA__SPO_NODE__URL: "ws://node:9944"
      APP__INFRA__SPO_NODE__BLOCKFROST_ID: "dummy-not-using-spo"
    healthcheck:
      test: ["CMD-SHELL", "cat /var/run/indexer-standalone/running"]
      start_interval: "5s"
      interval: "5s"
      timeout: "2s"
      retries: 2
      start_period: 5s
    depends_on:
      node:
        condition: service_started

  node:
    image: '${NODE_IMAGE}'
    container_name: "node"
    # Self-heal across Docker Desktop restarts / transient stops (see proof-server).
    restart: unless-stopped
    ports:
      - "9944:9944"
    # Healthy once block 1 exists, not just once /health answers: the indexer's
    # SPO indexer exits if it starts while the chain is at block 0.
    healthcheck:
      test:
        - "CMD-SHELL"
        - >-
          curl -sf -H 'Content-Type: application/json'
          -d '{"id":1,"jsonrpc":"2.0","method":"chain_getHeader","params":[]}'
          http://localhost:9944 | grep -q '"number":"0x[1-9a-f]'
      interval: 2s
      timeout: 5s
      retries: 30
      start_period: 5s
    environment:
      CFG_PRESET: "dev"
`;

/** How long one Docker command may run before it is killed. */
const DOCKER_TIMEOUT_MS = 30_000;

/** How the localnet's Docker commands run for one call. */
export interface DockerCall {
  /** The call's cancellation: the Docker client running then is killed, and the step fails with CancelledError. */
  readonly signal: AbortSignal;
  /** Runs a program (lib/exec-program.ts's execProgram spawns it). */
  readonly exec: ExecRunner;
  /** Docker's own stderr as it comes, where the call's text goes (the CLI shows it on the terminal). */
  readonly onStderr: (text: string) => void;
  /** The state root the localnet's compose file lives under. */
  readonly root: string;
}

/**
 * Check that `docker compose version` succeeds.
 * Returns the version string on success, or throws a descriptive error.
 */
export async function checkDockerAvailable({ signal, exec }: DockerCall): Promise<string> {
  // The probes' own stderr is kept: without Docker it is the system's "docker: not found", said better below.
  try {
    const output = await exec('docker', ['compose', 'version'], { signal, timeoutMs: 10_000 });
    return output.trim();
  } catch {
    throwIfCancelled(signal);
    // Try plain docker first to distinguish "no docker" from "no compose v2"
    try {
      await exec('docker', ['--version'], { signal, timeoutMs: 5_000 });
    } catch {
      throwIfCancelled(signal);
      throw new Error(
        'Docker is required but was not found.\n' +
        'Install Docker from https://docs.docker.com/get-docker/'
      );
    }
    throw new Error(
      'Docker Compose v2 is required.\n' +
      'Install it from https://docs.docker.com/compose/install/'
    );
  }
}

/**
 * Write compose.yml to the localnet folder if it doesn't exist or the version has changed.
 * Returns true if the file was written, false if it was already up to date.
 * The folder is the one under the state root `root`.
 */
export function ensureComposeFile(root: string): boolean {
  const versionMatches =
    existsSync(versionPath(root)) &&
    existsSync(composePath(root)) &&
    readFileSync(versionPath(root), 'utf-8').trim() === COMPOSE_VERSION;

  if (versionMatches) return false;

  mkdirSync(localnetDir(root), { recursive: true, mode: DIR_MODE });
  writeFileSync(composePath(root), COMPOSE_YAML, 'utf-8');
  writeFileSync(versionPath(root), COMPOSE_VERSION, 'utf-8');
  return true;
}

/**
 * Run `docker compose -f <path> <args>` and return stdout; Docker's stderr
 * goes to the call as it comes. Throws on non-zero exit with stderr in the
 * error message, and CancelledError when the call is cancelled.
 */
export function dockerCompose({ signal, exec, onStderr, root }: DockerCall, args: readonly string[]): Promise<string> {
  return exec('docker', ['compose', '-f', composePath(root), ...args], { signal, timeoutMs: DOCKER_TIMEOUT_MS, onStderr });
}

export interface ServiceStatus {
  name: string;
  state: string;
  health: string;
  port: string;
  image: string;
}

const PORT_MAP: Record<string, string> = {
  'node': '9944',
  'indexer': '8088',
  'proof-server': '6300',
};

/**
 * The services in `docker compose ps --format json` output: one JSON object
 * per line, unreadable lines skipped.
 */
export function parseServiceStatus(output: string): ServiceStatus[] {
  const services: ServiceStatus[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { Service?: string; State?: string; Health?: string; Image?: string };
      const name = obj.Service ?? 'unknown';
      services.push({
        name,
        state: obj.State ?? 'unknown',
        health: obj.Health ?? '',
        port: PORT_MAP[name] ?? '',
        image: obj.Image ?? '',
      });
    } catch {
      // skip unparseable lines
    }
  }
  return services;
}

/**
 * The localnet's services and their state, stopped ones included (`ps -a`): a
 * stopped localnet is not the same as none. Empty when there are no containers.
 */
export async function getServiceStatus(docker: DockerCall): Promise<ServiceStatus[]> {
  try {
    return parseServiceStatus(await dockerCompose(docker, ['ps', '-a', '--format', 'json']));
  } catch {
    throwIfCancelled(docker.signal);
    return [];
  }
}

/**
 * Poll service health until all services are healthy or timeout expires.
 * Returns true if all healthy, false on timeout; CancelledError when the call is cancelled.
 */
export async function waitForHealthy(docker: DockerCall, timeoutMs: number = 120_000, intervalMs: number = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const services = await getServiceStatus(docker);
    const allRunning = services.length === 3 &&
      services.every(s => s.state === 'running');

    if (allRunning) {
      // Check if services with healthchecks are healthy
      const healthyOrNoCheck = services.every(
        s => s.health === 'healthy' || s.health === ''
      );
      if (healthyOrNoCheck) return true;
    }

    await sleep(intervalMs, docker.signal);
  }

  return false;
}

/**
 * Starts the localnet's containers (`docker compose up -d`) and waits for
 * them to be healthy: true when they are, false when the wait timed out.
 * The command calls it after ensureComposeFile.
 * Cancelled, it fails with what localnetUpCancelled says.
 */
export async function startLocalnet(docker: DockerCall, onStatus: (status: string) => void, healthTimeoutMs: number = 120_000): Promise<boolean> {
  try {
    await dockerCompose(docker, ['up', '-d']);
    onStatus('Waiting for services to be healthy...');
    return await waitForHealthy(docker, healthTimeoutMs);
  } catch (err) {
    if (docker.signal.aborted) throw await localnetUpCancelled(docker);
    throw err;
  }
}

/** How long listing what a cancelled `localnet up` left may take. */
const CANCELLED_LISTING_TIMEOUT_MS = 10_000;

/**
 * What a cancelled `localnet up` fails with: the containers it
 * started stay in place, and the error says which, as Docker lists them now.
 * Listing them is not cancelled with the call (it has been already); it is
 * bounded by its own time limit. When Docker can't list them, the error says
 * so rather than claim none were started.
 */
export async function localnetUpCancelled({ exec, root }: Omit<DockerCall, 'signal'>): Promise<CancelledError> {
  let left: ServiceStatus[];
  try {
    left = parseServiceStatus(await exec('docker', ['compose', '-f', composePath(root), 'ps', '-a', '--format', 'json'], {
      signal: new AbortController().signal,
      timeoutMs: CANCELLED_LISTING_TIMEOUT_MS,
    }));
  } catch {
    return new CancelledError(
      `${CANCELLED_MESSAGE}: localnet up was stopped, and Docker could not list its containers, so some may still be running.\n` +
      'Run "midnight localnet status" to see them, and "midnight localnet down" to remove them.',
    );
  }
  if (left.length === 0) return new CancelledError(`${CANCELLED_MESSAGE}: localnet up was stopped before it started any container.`);
  const listed = left.map((s) => `${s.name} (${s.state})`).join(', ');
  return new CancelledError(
    `${CANCELLED_MESSAGE}: localnet up was stopped; the containers it started stay in place: ${listed}.\n` +
    'Run "midnight localnet down" to remove them, or "midnight localnet up" to finish starting the network.',
  );
}

/** Return the compose file path under the state root `root` (for display purposes). */
export function getComposePath(root: string): string {
  return composePath(root);
}

// Container names used in compose.yml — these are the hardcoded container_name values
export const CONTAINER_NAMES = ['node', 'indexer', 'proof-server'] as const;

/** The compose project mn's localnet containers belong to: compose names it after the compose file's directory. */
export const LOCALNET_PROJECT = LOCALNET_DIR_NAME;

/** A container with one of mn's container names, and the compose project that created it ('' if none). */
export interface NamedContainer {
  name: string;
  project: string;
}

/** Which of the containers bearing mn's names are mn's to remove: only those of mn's own compose project. */
export function partitionLocalnetContainers(found: readonly NamedContainer[]): { remove: string[]; keep: NamedContainer[] } {
  return {
    remove: found.filter((c) => c.project === LOCALNET_PROJECT).map((c) => c.name),
    keep: found.filter((c) => c.project !== LOCALNET_PROJECT),
  };
}

/**
 * Remove the containers named like mn's localnet services that mn's compose
 * project created (also from an older mn). A container with one of those
 * generic names from anything else is left alone and returned in `kept`.
 */
export async function removeConflictingContainers({ signal, exec, onStderr }: DockerCall): Promise<{ removed: string[]; kept: NamedContainer[] }> {
  const found: NamedContainer[] = [];
  for (const name of CONTAINER_NAMES) {
    // `docker ps` lists containers only (an image named "node" is not one) and
    // prints nothing when no container has the name.
    let listed: string;
    try {
      listed = await exec(
        'docker',
        ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}|{{.Label "com.docker.compose.project"}}'],
        { signal, timeoutMs: 10_000, onStderr },
      );
    } catch {
      throwIfCancelled(signal);
      // Docker couldn't say: report the name as left alone rather than guess.
      found.push({ name, project: '(unknown: docker ps failed)' });
      continue;
    }
    const line = listed.split('\n').find((l) => l.startsWith(`${name}|`));
    if (line) found.push({ name, project: line.slice(name.length + 1).trim() });
  }
  const { remove, keep } = partitionLocalnetContainers(found);
  const removed: string[] = [];
  for (const name of remove) {
    try {
      await exec('docker', ['rm', '-f', name], { signal, timeoutMs: 10_000, onStderr });
      removed.push(name);
    } catch {
      throwIfCancelled(signal);
      // Already gone — fine
    }
  }
  return { removed, kept: keep };
}
