// serve command — start DApp Connector server over WebSocket JSON-RPC
// Usage: midnight serve [--port 9932] [--wallet path] [--network name]
//                       [--approve-all | --approve-fees] [--allow-origin <origin>]... [--no-auto-approve-reads] [--json]

import { type ParsedArgs, getFlag, getFlagValues, hasFlag, rejectNoCacheForWrites, resolveNetwork, applyEndpointOverrides, type DAppConnector, type DAppConnectorCallbacks, OPERATOR_REJECTED_MESSAGE, type PhaseTiming, DEFAULT_SERVE_PORT, shieldedSyncEnabled, parseFeeLimits, describeApprovalPolicy, type CallContext, UsageError, throwIfCancelled } from '@kuiralabs/midnight-cli-core';
import { header, divider, formatAddress, bold, dim, teal, green, red, yellow, type Spinner } from '@kuiralabs/midnight-cli-core/ui';
import { resolveWalletPath, unlockWallet } from '@kuiralabs/midnight-wallet';
import { assertEndpointsReachable, endpointsOf } from '@kuiralabs/midnight-chain';
import { createRpcServer, type RpcServer } from '../lib/ws-rpc.ts';
import { approveAllBrowserWarning, serveHeaderLines } from '../lib/serve-header.ts';
import { parseAllowedOrigins } from '../lib/allowed-origins.ts';

export default async function serveCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  rejectNoCacheForWrites(args);
  // ── Parse args ──

  const portStr = getFlag(args, 'port');
  const port = portStr !== undefined && /^\d+$/.test(portStr) ? Number(portStr) : portStr === undefined ? DEFAULT_SERVE_PORT : Number.NaN;
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new UsageError(`Invalid port: "${portStr}" — must be 1-65535`);
  }

  const approveAll = hasFlag(args, 'approve-all');
  // Fee wallet: auto-approve only Dust-fee balancing and the submit of what it balanced.
  const approveFees = hasFlag(args, 'approve-fees');
  if (approveAll && approveFees) {
    throw new UsageError('--approve-all and --approve-fees conflict: --approve-fees approves only fee payment, --approve-all approves everything. Pass one.');
  }
  const maxFeeFlag = getFlag(args, 'max-fee');
  const maxPendingFlag = getFlag(args, 'max-pending');
  if (!approveFees && (maxFeeFlag !== undefined || maxPendingFlag !== undefined)) {
    throw new UsageError('--max-fee and --max-pending only apply with --approve-fees.');
  }
  const feeLimits = parseFeeLimits(maxFeeFlag, maxPendingFlag);
  // Browser pages connect only from these origins: a page the user merely opens must not reach the wallet.
  const allowedOrigins = parseAllowedOrigins(getFlagValues(args, 'allow-origin'));
  // Read methods never prompt, and balancing prompts unless --approve-all or
  // --approve-fees, so --no-auto-approve-reads (which made balancing prompt
  // before that was the default) has nothing left to do.
  const autoApproveReads = true;
  const noAutoApproveReadsGiven = hasFlag(args, 'no-auto-approve-reads');
  const jsonMode = hasFlag(args, 'json');

  // ── Load wallet ──

  const root = ctx.config.paths.stateRoot;
  const config = await unlockWallet(resolveWalletPath(root, getFlag(args, 'wallet')), { root, host: ctx.host });
  const seedBuffer = Buffer.from(config.seed, 'hex');

  const { name: networkName, config: networkConfig } = resolveNetwork({ args, configDir: root }, ctx.config.settings);
  const address = config.addresses[networkName];

  // Apply endpoint overrides: --flag > config > network default
  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName, root);

  // The indexer and the node answer before the wallet syncs: the wallet SDK
  // would retry one it can't reach for ever.
  await assertEndpointsReachable(endpointsOf(networkConfig), { signal: ctx.signal });

  // ── Header ──

  ctx.output.stderr('\n' + header('DApp Connector Server') + '\n\n');
  const policy = describeApprovalPolicy({ approveAll, approveFees, autoApproveReads }, feeLimits);
  for (const line of serveHeaderLines({ network: networkName, address: formatAddress(address, true), port, allowedOrigins }, policy, feeLimits)) ctx.output.stderr(line + '\n');
  const browserWarning = approveAllBrowserWarning(policy, allowedOrigins);
  if (browserWarning !== undefined) ctx.output.stderr('\n  ' + yellow(browserWarning) + '\n');
  if (noAutoApproveReadsGiven) {
    ctx.output.stderr(dim('  --no-auto-approve-reads has no effect: read methods never prompt, and balancing prompts unless --approve-all or --approve-fees') + '\n');
  }
  ctx.output.stderr('\n');

  // ── Suppress SDK noise ──

  const stopListening = ctx.sdkWarnings.listen((_tag, msg) => {
    const s = ctx.progress.active();
    if (s) { s.log(dim(`  SDK: ${msg}`)); }
    else { ctx.output.stderr(dim(`  SDK: ${msg}`) + '\n'); }
  });

  // ── Sync the wallet, through the engine for the network ──
  // The engine owns validating the caches, priming Dust, building the
  // wallet, syncing (with retries) and stopping it. Saving is ours: skipped
  // while transactions are pending, to avoid persisting dust=0 (see the
  // `connector.hasPendingTxs()` check below).

  const spinner = ctx.progress.start('Syncing wallet...');
  // Where shielded is off by default (mainnet, preview, preprod), serve is
  // ready once unshielded and Dust are synced; the shielded wallet keeps
  // syncing behind, so its balances may be short until it catches up.
  const syncMode = shieldedSyncEnabled(networkName, hasFlag(args, 'force-shielded')) ? 'full' : 'lite';

  await (await ctx.host.engines.for(networkName)).wallet.serveWallet({ seed: seedBuffer, root, notice: ctx.host.notice, waiting: ctx.host.waiting, networkConfig, network: networkName, address, syncMode, signal: ctx.signal, log: ctx.diagnostics.line,
    onStatus: (s) => spinner.update(s),
    onSyncProgress: (applied, highest) => {
      if (highest > 0) {
        const pct = Math.min(Math.round((applied / highest) * 100), 100);
        spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
      }
    },
    onSyncDetail: (detail) => spinner.update(`Syncing wallet... (waiting on: ${detail})`),
  }, async (served) => {
    spinner.stop('Wallet synced');

    // Wait for dust coins to actually be available before accepting write requests.
    // On preprod this can take 10-30s after sync completes.
    const dustSpinner = ctx.progress.start('Waiting for dust...');
    const hasDust = await served.waitForDust();
    dustSpinner.stop(hasDust ? 'Dust ready' : 'Dust not yet available (writes may fail)');

    // Save cache after successful sync (checkpoint before opening RPC).
    await served.saveState();

    throwIfCancelled(ctx.signal);

    let server: RpcServer | undefined;
    let connector: DAppConnector | undefined;
    try {
      // ── Create DApp Connector ──

    // Phase labels for human-readable spinner messages
    const PHASE_LABELS: Record<string, string> = {
      approve: 'Waiting for approval...',
      building: 'Building transaction...',
      signing: 'Signing...',
      proving: 'Proving (ZK)...',
      submitting: 'Submitting...',
    };

    // Track per-connection spinners for write operations
    let activeSpinner: Spinner | undefined;

    const phaseCallbacks: DAppConnectorCallbacks = {
      onPhaseStart: (_connId, _method, phase) => {
        // The 'approve' phase uses the interactive approval prompt — no spinner
        if (phase === 'approve') return;
        const label = PHASE_LABELS[phase] ?? `${phase}...`;
        if (activeSpinner) {
          activeSpinner.update(label);
        } else {
          activeSpinner = ctx.progress.start(label);
        }
      },
      onPhaseComplete: (_connId, _method, phase, durationMs) => {
        // No spinner was started for approve — skip
        if (phase === 'approve') return;
        // Stop spinner after the final phase (proving or submitting)
        if (phase === 'proving' || phase === 'submitting') {
          activeSpinner?.stop(`${phase} ${formatDuration(durationMs)}`);
          activeSpinner = undefined;
        }
      },
    };

    // Reads answer from the state the Dust wait ended on, and from every
    // later one that is synced by the rule the sync used.
    connector = served.connect({
      approvalOptions: { approveAll, approveFees, autoApproveReads, prompter: ctx.host.prompter, notice: ctx.host.notice },
      feeLimits,
      callbacks: phaseCallbacks,
    });

    // ── Start WebSocket server ──

    server = createRpcServer({
      host: ctx.host,
      port,
      handlers: connector.handlers,
      allowedOrigins,
      onOriginRefused: (origin) => {
        ctx.output.stderr(dim(`  [${timestamp()}] `) + red('refused') + dim(` a connection from ${origin}: not an allowed origin (start mn serve with --allow-origin ${origin} to let that page connect)`) + '\n');
      },
      onConnect: (conn) => {
        ctx.output.stderr(dim(`  [${timestamp()}] `) + green('connected') + dim(` ${conn.id}`) + '\n');
      },
      onDisconnect: (conn) => {
        ctx.output.stderr(dim(`  [${timestamp()}] `) + red('disconnected') + dim(` ${conn.id}`) + '\n');
        // Revert any unsubmitted transactions to release pending coins (dust)
        connector?.revertPendingTxs(conn.id).catch(() => { /* best-effort */ });
      },
      onRequest: (conn, req) => {
        ctx.output.stderr(dim(`  [${timestamp()}] ${conn.id} #${conn.requestCount} → ${req.method}`) + '\n');
      },
      onResponse: (conn, req, durationMs, result, error, metadata) => {
        // Clean up any lingering spinner from an error path
        if (error && activeSpinner) {
          activeSpinner.fail('Failed');
          activeSpinner = undefined;
        }

        const duration = formatDuration(durationMs);
        if (error) {
          // A prompt the operator declined, versus a refusal by policy (e.g. fee limits).
          const label = error.code === 'Rejected' && error.message === OPERATOR_REJECTED_MESSAGE
            ? 'rejected by operator'
            : error.message;
          ctx.output.stderr(`  ${red('✗')} ${dim(`${conn.id} ← ${req.method} (${duration})`)} ${red(label)}` + '\n');
          // Always show the full error message for non-rejection failures
          if (error.code !== 'Rejected' && error.message) {
            ctx.output.stderr(`  ${dim('  error:')} ${error.message}` + '\n');
          }
        } else {
          // Build timing breakdown from phase metadata
          const phases = metadata?.phases as PhaseTiming[] | undefined;
          const timingStr = phases && phases.length > 0
            ? ': ' + phases.map(p => `${p.phase} ${formatDuration(p.durationMs)}`).join(', ')
            : '';
          ctx.output.stderr(`  ${green('✓')} ${dim(`${conn.id} ← ${req.method} (${duration}${timingStr})`)}` + '\n');
          // Log tx hash after successful submit
          const txHash = (result as any)?.txHash;
          if (req.method === 'submitTransaction' && txHash) {
            ctx.output.stderr(`  ${dim('  tx:')} ${teal(String(txHash))}` + '\n');
          }
        }
      },
    });

    // ── Server ready ──
    // Only once the port is bound. If it's taken, whatever already listens
    // there (often an older mn serve with other approval flags) would answer
    // clients in our place, so fail instead of claiming to be ready.
    try {
      await server.ready;
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw new Error(
        code === 'EADDRINUSE'
          ? `Port ${port} is already in use (another mn serve?). Stop it or pass --port <n>.`
          : `Could not listen on port ${port}: ${(err as Error).message}`,
      );
    }

    ctx.output.stderr('\n' + divider() + '\n');
    ctx.output.stderr('  ' + bold(teal(`Server ready — listening on ws://localhost:${port}`)) + '\n');
    ctx.output.stderr(dim('  Press Ctrl+C to stop') + '\n\n');

    if (jsonMode) {
      ctx.output.result({
        port,
        network: networkName,
        address,
        status: 'listening',
        approval: policy,
        allowedOrigins,
        ...(browserWarning !== undefined ? { warning: browserWarning } : {}),
      });
    }

    // ── Wait for shutdown signal ──
    // The abort signal comes from wallet.ts's global SIGINT/SIGTERM handler.
    // We don't register our own signal handlers — wallet.ts handles that.

    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) {
        resolve();
      } else {
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      }
    });

      // ── Shutdown ──

      ctx.output.stderr('\n' + dim('  Shutting down...') + '\n');
      // Save cache on graceful shutdown — but NOT if transactions are pending.
      // The SDK drops pendingDustTokens on serialization, so saving while coins
      // are locked in pending would persist a corrupted state (dust=0).
      if (!connector.hasPendingTxs()) {
        await served.saveState();
      }
      try { await server.close(); } catch { /* best-effort */ }
      connector.dispose();
      connector = undefined;
      server = undefined;
      ctx.output.stderr(dim('  Server stopped.') + '\n\n');
    } catch (err) {
      spinner.fail('Failed');
      if (server) { try { await server.close(); } catch { /* best-effort */ } }
      connector?.dispose();
      throw err;
    }
  }).finally(() => {
    stopListening();
  });
}

// ── Helpers ──

function timestamp(): string {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
