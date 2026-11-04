// status command — show Midnight network health
// Usage: midnight status [--network <name>] [--all] [--json] [--watch]
//
// Runs local Tier 1 probes (real-time from your network) and overlays
// canary data from the dashboard (hourly monitoring history).
// No wallet or SDK needed — works from anywhere.

import { type ParsedArgs, getFlag, hasFlag, DASHBOARD_BASE_URL, BlockfrostProjectIdRequiredError, assertEndpointUsable, endpointRefusal, isValidNetworkName, resolveNetworkConfig, type NetworkName, resolveBlockfrostProjectId, type NetworkSettings, CancelledError, type CallContext, type CallOutput, type CommandOutcome } from '@kuiralabs/midnight-cli-core';
import { header, divider, bold, dim, teal, green, red, gray } from '@kuiralabs/midnight-cli-core/ui';


// ── Types matching status.json contract ──

type ServiceStatus = 'up' | 'down' | 'degraded' | 'unknown';

interface ProbeResult {
  status: ServiceStatus;
  latencyMs: number;
  lastChecked: string;
  notes?: string;
  peers?: number;
  isSyncing?: boolean;
  blockHeight?: number;
}

interface StatusJson {
  lastUpdated: string | null;
  networks: Record<string, Record<string, ProbeResult>>;
}

interface Issue {
  id: string;
  summary: string;
  affects: string;
  component: string;
  status: string;
}

interface IssuesJson {
  lastUpdated: string;
  issues: Issue[];
}

// ── Response types for external API calls ──

interface IndexerBlockResponse {
  data?: {
    block?: {
      height?: number;
    };
  };
}

interface SystemHealthResponse {
  result?: {
    peers: number;
    isSyncing: boolean;
    shouldHavePeers: boolean;
  };
}

// ── Faucet/explorer URLs (not in network.ts — only used for status probes) ──

const EXTRA_ENDPOINTS: Record<string, { faucet: string; explorer: string | null }> = {
  preprod: {
    faucet: 'https://faucet.preprod.midnight.network/',
    explorer: 'https://preprod.midnightexplorer.com/',
  },
  preview: {
    faucet: 'https://faucet.preview.midnight.network/',
    explorer: null,
  },
  undeployed: {
    faucet: '',
    explorer: '',
  },
};

// ── Service display config ──

const SERVICE_LABELS: Record<string, string> = {
  indexer: 'Indexer',
  rpc: 'RPC Node',
  faucet: 'Faucet',
  explorer: 'Explorer',
  chain: 'Chain',
  dust: 'Dust Generation',
  wallet: 'Wallet Ops',
  dapp: 'DApp Flow',
};

const STATUS_ICONS: Record<string, string> = {
  up: green('UP'),
  down: red('DOWN'),
  degraded: bold('\x1b[33mDEGRADED\x1b[0m'),
  unknown: dim('—'),
};

const PROBE_TIMEOUT_MS = 15_000;
const DEGRADED_THRESHOLD_MS = 5_000;
const FAUCET_DEGRADED_THRESHOLD_MS = 10_000;

// ── Helpers ──

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

function overallStatus(services: Record<string, ProbeResult>): 'up' | 'degraded' | 'down' {
  let hasDown = false;
  let hasDegraded = false;
  for (const result of Object.values(services)) {
    if (result.status === 'down') hasDown = true;
    if (result.status === 'degraded') hasDegraded = true;
  }
  if (hasDown) return 'down';
  if (hasDegraded) return 'degraded';
  return 'up';
}

/** A signal that aborts after `ms`, or when the call's signal does. */
function timeoutOrCancel(ms: number, signal: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(ms), signal]);
}

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const url = `${DASHBOARD_BASE_URL}${path}`;
  const response = await fetch(url, { signal: timeoutOrCancel(10_000, signal) });
  if (!response.ok) {
    throw new Error(`Dashboard returned HTTP ${response.status} for ${path}`);
  }
  return response.json() as Promise<T>;
}

async function tryDetectNetwork(args: ParsedArgs, root: string): Promise<string | undefined> {
  const flagNetwork = getFlag(args, 'network');
  if (flagNetwork) return flagNetwork;

  // Check config file for default network
  try {
    const { loadCliConfig } = await import('@kuiralabs/midnight-cli-core');
    const config = loadCliConfig(root);
    if (config.network && isValidNetworkName(config.network)) return config.network;
  } catch {
    // fall through
  }

  return undefined;
}

// ── Local Tier 1 probes ──

async function timedFetch(
  url: string,
  signal: AbortSignal,
  options: RequestInit = {},
): Promise<{ response: Response; latencyMs: number }> {
  // A probe that runs too long is aborted (its note says so, as ever); so is every probe of a cancelled call.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.any([controller.signal, signal]) });
    return { response, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

/** Why an endpoint can't be probed at all (no Blockfrost project id, or it was shut down), as a result. */
function unprobeable(url: string, now: string): ProbeResult | undefined {
  try {
    assertEndpointUsable(url);
    return undefined;
  } catch (err) {
    const notes = err instanceof BlockfrostProjectIdRequiredError
      ? 'Needs a Blockfrost project id: midnight config set blockfrost-project-id <project id>'
      : (err as Error).message.split('\n')[0]!;
    return { status: 'unknown', latencyMs: 0, lastChecked: now, notes };
  }
}

/** What a refusing status means for this endpoint, in a line; undefined when it has no special meaning. */
function refusalNote(url: string, status: number): string | undefined {
  return endpointRefusal(url, status)?.message.split('\n')[0];
}

async function probeIndexer(indexerUrl: string, signal: AbortSignal): Promise<ProbeResult> {
  const now = new Date().toISOString();
  const cannot = unprobeable(indexerUrl, now);
  if (cannot) return cannot;
  try {
    const { response, latencyMs } = await timedFetch(indexerUrl, signal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }),
    });
    if (!response.ok) {
      const refusal = refusalNote(indexerUrl, response.status);
      if (refusal) return { status: 'down', latencyMs, lastChecked: now, notes: refusal };
      if (response.status === 403) return { status: 'degraded', latencyMs, lastChecked: now, notes: 'HTTP 403 — likely WAF blocking' };
      return { status: 'down', latencyMs, lastChecked: now, notes: `HTTP ${response.status}` };
    }
    const body = await response.json() as IndexerBlockResponse;
    if (!body?.data) return { status: 'down', latencyMs, lastChecked: now, notes: 'No data field' };
    const blockHeight = body.data?.block?.height;
    return {
      status: latencyMs > DEGRADED_THRESHOLD_MS ? 'degraded' : 'up',
      latencyMs,
      lastChecked: now,
      ...(blockHeight !== undefined ? { blockHeight } : {}),
      ...(latencyMs > DEGRADED_THRESHOLD_MS ? { notes: `Slow (${latencyMs}ms)` } : {}),
    };
  } catch (err) {
    return { status: 'down', latencyMs: 0, lastChecked: now, notes: (err as Error).message };
  }
}

async function probeRpc(nodeUrl: string, signal: AbortSignal): Promise<ProbeResult> {
  const now = new Date().toISOString();
  const cannot = unprobeable(nodeUrl, now);
  if (cannot) return cannot;
  // Convert wss:// to https:// for HTTP POST
  const httpUrl = nodeUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  try {
    const { response, latencyMs } = await timedFetch(httpUrl, signal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }),
    });
    if (!response.ok) {
      const refusal = refusalNote(nodeUrl, response.status);
      if (refusal) return { status: 'down', latencyMs, lastChecked: now, notes: refusal };
      if (response.status === 403) return { status: 'degraded', latencyMs, lastChecked: now, notes: 'HTTP 403 — likely WAF blocking' };
      return { status: 'down', latencyMs, lastChecked: now, notes: `HTTP ${response.status}` };
    }
    const body = await response.json() as SystemHealthResponse;
    const result = body?.result;
    if (!result) return { status: 'down', latencyMs, lastChecked: now, notes: 'No result in response' };
    const peers = result.peers ?? 0;
    const isSyncing = result.isSyncing ?? false;
    let status: ServiceStatus = 'up';
    let notes: string | undefined;
    if (isSyncing) { status = 'degraded'; notes = 'Node is syncing'; }
    else if (peers === 0) { status = 'degraded'; notes = 'No peers'; }
    return { status, latencyMs, lastChecked: now, peers, isSyncing, ...(notes ? { notes } : {}) };
  } catch (err) {
    return { status: 'down', latencyMs: 0, lastChecked: now, notes: (err as Error).message };
  }
}

async function probeFaucet(faucetUrl: string, signal: AbortSignal): Promise<ProbeResult> {
  const now = new Date().toISOString();
  if (!faucetUrl) return { status: 'unknown', latencyMs: 0, lastChecked: now, notes: 'No faucet URL' };
  try {
    const { response, latencyMs } = await timedFetch(faucetUrl, signal);
    if (!response.ok) return { status: 'down', latencyMs, lastChecked: now, notes: `HTTP ${response.status}` };
    return {
      status: latencyMs > FAUCET_DEGRADED_THRESHOLD_MS ? 'degraded' : 'up',
      latencyMs,
      lastChecked: now,
      ...(latencyMs > FAUCET_DEGRADED_THRESHOLD_MS ? { notes: `Slow (${latencyMs}ms)` } : {}),
    };
  } catch (err) {
    return { status: 'down', latencyMs: 0, lastChecked: now, notes: (err as Error).message };
  }
}

async function probeExplorer(explorerUrl: string | null, signal: AbortSignal): Promise<ProbeResult> {
  const now = new Date().toISOString();
  if (!explorerUrl) return { status: 'unknown', latencyMs: 0, lastChecked: now, notes: 'URL not configured' };
  try {
    const { response, latencyMs } = await timedFetch(explorerUrl, signal);
    if (!response.ok) return { status: 'down', latencyMs, lastChecked: now, notes: `HTTP ${response.status}` };
    const body = await response.text();
    if (!body || body.length === 0) return { status: 'down', latencyMs, lastChecked: now, notes: 'Empty response' };
    return {
      status: latencyMs > DEGRADED_THRESHOLD_MS ? 'degraded' : 'up',
      latencyMs,
      lastChecked: now,
      ...(latencyMs > DEGRADED_THRESHOLD_MS ? { notes: `Slow (${latencyMs}ms)` } : {}),
    };
  } catch (err) {
    return { status: 'down', latencyMs: 0, lastChecked: now, notes: (err as Error).message };
  }
}

/** The live probes of one network; a cancelled call's probes stop at once (their results then mean nothing). */
async function runLocalProbes(networkName: string, root: string, settings: NetworkSettings, signal: AbortSignal): Promise<Record<string, ProbeResult>> {
  if (!isValidNetworkName(networkName)) return {};

  const netConfig = resolveNetworkConfig(networkName as NetworkName, {
    isLocalDetectOff: settings.isLocalDetectOff,
    blockfrostProjectId: resolveBlockfrostProjectId(networkName as NetworkName, root, settings),
  });
  const extra = EXTRA_ENDPOINTS[networkName];
  if (!extra) return {};

  const [indexer, rpc, faucet, explorer] = await Promise.all([
    probeIndexer(netConfig.indexer, signal),
    probeRpc(netConfig.node, signal),
    probeFaucet(extra.faucet, signal),
    probeExplorer(extra.explorer, signal),
  ]);

  return { indexer, rpc, faucet, explorer };
}

// ── Render functions ──

function renderHealthTable(
  output: CallOutput,
  networkName: string,
  canaryServices: Record<string, ProbeResult> | undefined,
  liveServices: Record<string, ProbeResult>,
): void {
  output.stderr('\n  ' + bold(networkName) + '\n');
  output.stderr(dim('  ' + '─'.repeat(62)) + '\n');

  // Merge: show live probes first, then canary-only services (chain, dust, wallet, dapp)
  const allServices = new Set([
    ...Object.keys(liveServices),
    ...(canaryServices ? Object.keys(canaryServices) : []),
  ]);

  for (const service of allServices) {
    const live = liveServices[service];
    const canary = canaryServices?.[service];

    const label = (SERVICE_LABELS[service] ?? service).padEnd(18);

    if (live) {
      // Show live result
      const icon = STATUS_ICONS[live.status] ?? dim('—');
      const latency = live.latencyMs > 0 ? dim(` ${live.latencyMs}ms`) : '';
      const notes = live.notes ? dim(` — ${live.notes}`) : '';

      // If canary has a different status, show it as context
      let canaryNote = '';
      if (canary && canary.status !== live.status && canary.status !== 'unknown') {
        canaryNote = dim(` (canary: ${canary.status}${canary.lastChecked ? ' ' + formatAge(canary.lastChecked) : ''})`);
      }

      output.stderr(`  ${gray(label)}${icon}${latency}${notes}${canaryNote}\n`);
    } else if (canary) {
      // Canary-only service (chain, dust, wallet, dapp)
      const icon = STATUS_ICONS[canary.status] ?? dim('—');
      const latency = canary.latencyMs > 0 ? dim(` ${canary.latencyMs}ms`) : '';
      const checked = canary.lastChecked ? dim(` (${formatAge(canary.lastChecked)})`) : '';
      const notes = canary.notes ? dim(` — ${canary.notes}`) : '';

      output.stderr(`  ${gray(label)}${icon}${latency}${checked}${notes}\n`);
    }
  }
}

function renderIssues(output: CallOutput, issues: Issue[], networkFilter?: string): void {
  const filtered = networkFilter
    ? issues.filter(i => i.affects.toLowerCase().includes(networkFilter.toLowerCase()))
    : issues;

  if (filtered.length === 0) return;

  output.stderr('\n' + header('Known Issues') + '\n\n');
  for (const issue of filtered) {
    output.stderr(`  ${red(issue.id.padEnd(28))}${issue.summary}\n`);
    output.stderr(`  ${' '.repeat(28)}${dim(issue.status)}\n`);
  }
}

// ── Command ──

export default async function statusCommand(args: ParsedArgs, ctx: CallContext): Promise<CommandOutcome | void> {
  const jsonMode = hasFlag(args, 'json');
  const showAll = hasFlag(args, 'all');
  const watchMode = hasFlag(args, 'watch');

  // Determine target network(s) first
  const detected = (await tryDetectNetwork(args, ctx.config.paths.stateRoot)) ?? 'preprod';

  // Fetch canary data + run local probes in parallel
  const spinner = ctx.progress.start('Checking network status...');

  let status: StatusJson | null = null;
  let issues: IssuesJson | null = null;
  let canaryError: string | undefined;

  // Determine networks for local probes
  let targetNetworks: string[];
  if (showAll) {
    targetNetworks = ['preprod', 'preview'];
  } else {
    targetNetworks = [detected];
  }

  // Run everything in parallel: canary fetch + local probes
  const [canaryResult, ...liveResults] = await Promise.all([
    // Canary data (best-effort)
    Promise.all([
      fetchJson<StatusJson>('/api/status', ctx.signal),
      fetchJson<IssuesJson>('/api/issues', ctx.signal),
    ]).catch((err) => {
      canaryError = (err as Error).message;
      return null;
    }),
    // Local probes per network
    ...targetNetworks.map(name => runLocalProbes(name, ctx.config.paths.stateRoot, ctx.config.settings, ctx.signal)),
  ]);

  // Cancelled: the probes stopped early, so what they found says nothing about the network.
  if (ctx.signal.aborted) {
    spinner.fail('Cancelled');
    throw new CancelledError();
  }

  if (canaryResult) {
    [status, issues] = canaryResult;
  }

  spinner.stop('Done');

  // Build live results map
  const liveByNetwork: Record<string, Record<string, ProbeResult>> = {};
  for (let i = 0; i < targetNetworks.length; i++) {
    liveByNetwork[targetNetworks[i]] = liveResults[i] as Record<string, ProbeResult>;
  }

  // JSON mode
  if (jsonMode) {
    const result: Record<string, unknown> = {
      lastUpdated: status?.lastUpdated ?? null,
      dashboard: DASHBOARD_BASE_URL,
      canaryAvailable: status !== null,
      networks: {} as Record<string, unknown>,
    };

    for (const name of targetNetworks) {
      const live = liveByNetwork[name] ?? {};
      const canary = status?.networks[name];
      // Merge: live probes + canary-only services
      const merged = { ...canary, ...live };
      (result.networks as Record<string, unknown>)[name] = {
        overall: overallStatus(merged),
        live,
        canary: canary ?? null,
      };
    }

    if (issues) {
      const networkFilter = showAll ? undefined : targetNetworks[0];
      result.issues = networkFilter
        ? issues.issues.filter(i => i.affects.toLowerCase().includes(networkFilter.toLowerCase()))
        : issues.issues;
    }

    if (canaryError) result.canaryError = canaryError;

    ctx.output.result(result);

    const worstStatus = targetNetworks.reduce((worst, name) => {
      const merged = { ...(status?.networks[name] ?? {}), ...(liveByNetwork[name] ?? {}) };
      const s = overallStatus(merged);
      if (s === 'down') return 'down';
      if (s === 'degraded' && worst !== 'down') return 'degraded';
      return worst;
    }, 'up' as string);

    return outcomeOf(worstStatus);
  }

  // ── Render ──

  const renderOnce = () => {
    ctx.output.stderr('\n' + header('Midnight Network Status') + '\n');

    if (status?.lastUpdated) {
      ctx.output.stderr(dim(`  Canary: ${formatAge(status.lastUpdated)}`) + '  ');
    }
    ctx.output.stderr(dim(`Live: just now`) + '\n');

    if (canaryError) {
      ctx.output.stderr(dim(`  (Dashboard unreachable: ${canaryError})`) + '\n');
    }

    if (targetNetworks.length === 0) {
      ctx.output.stderr('\n  ' + dim('No network data available.') + '\n\n');
      return;
    }

    // Health tables — live + canary overlay
    for (const name of targetNetworks) {
      renderHealthTable(ctx.output, name, status?.networks[name], liveByNetwork[name] ?? {});
    }

    // Known issues
    if (issues) {
      const networkFilter = showAll ? undefined : targetNetworks[0];
      renderIssues(ctx.output, issues.issues, networkFilter);
    }

    // Dashboard link
    ctx.output.stderr('\n' + divider() + '\n');
    ctx.output.stderr(dim('  Dashboard: ') + teal(DASHBOARD_BASE_URL) + '\n\n');
  };

  renderOnce();

  // Watch mode: re-probe every 30s
  if (watchMode) {
    const interval = setInterval(async () => {
      try {
        // Re-fetch canary + re-run live probes
        const [newCanary, ...newLive] = await Promise.all([
          Promise.all([
            fetchJson<StatusJson>('/api/status', ctx.signal),
            fetchJson<IssuesJson>('/api/issues', ctx.signal),
          ]).catch(() => null),
          ...targetNetworks.map(name => runLocalProbes(name, ctx.config.paths.stateRoot, ctx.config.settings, ctx.signal)),
        ]);
        // Watching ended while this refresh ran: nothing to show.
        if (ctx.signal.aborted) return;

        if (newCanary) [status, issues] = newCanary;
        for (let i = 0; i < targetNetworks.length; i++) {
          liveByNetwork[targetNetworks[i]] = newLive[i] as Record<string, ProbeResult>;
        }

        ctx.output.stderr('\x1b[2J\x1b[H');
        renderOnce();
      } catch {
        ctx.output.stderr(dim(`  Refresh failed — retrying in 30s`) + '\n');
      }
    }, 30_000);

    // Watching ends when the call is cancelled (Ctrl+C), its normal end: it exits 0, as it always has.
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) resolve();
      else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    clearInterval(interval);
    return { exitCode: 0 };
  }

  // Exit code
  const worstStatus = targetNetworks.reduce((worst, name) => {
    const merged = { ...(status?.networks[name] ?? {}), ...(liveByNetwork[name] ?? {}) };
    const s = overallStatus(merged);
    if (s === 'down') return 'down';
    if (s === 'degraded' && worst !== 'down') return 'degraded';
    return worst;
  }, 'up' as string);

  return outcomeOf(worstStatus);
}

/** The exit code a status ends with, which the shell sets: 2 when a network is down, 1 when one is degraded. */
function outcomeOf(worstStatus: string): CommandOutcome | void {
  if (worstStatus === 'down') return { exitCode: 2 };
  if (worstStatus === 'degraded') return { exitCode: 1 };
}
