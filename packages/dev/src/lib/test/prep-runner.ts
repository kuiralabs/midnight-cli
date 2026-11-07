// Prep runner — execute prep steps defined in dapp.test.json by calling existing lib functions.

import { join } from 'node:path';

import { clearWalletCache, resolveNetwork, type NetworkConfig, type NetworkName, OWN_COMMAND_DUST_WAIT_MS, DustRequiredError, InsufficientBalanceError, throwIfCancelled, sdkSetOf, nightToMicro } from '@kuiralabs/midnight-cli-core';
import { resolveWalletPath, unlockWallet } from '@kuiralabs/midnight-wallet';
import { assertLedger9StackReachable, assertLedgerSupported } from '@kuiralabs/midnight-chain';

import type { DappTestConfig, PrepStepId, PrepStepResult, PrepContext, PrepCallbacks } from './types.ts';
import { originOfPage, startServeOrReuse } from '@kuiralabs/midnight-connect';
import { startBuild } from './build-manager.ts';

/** A prep step failed: the step's own error is its cause, and its code (DUST_REQUIRED, …) is this one's. */
export class PrepStepFailedError extends Error {
  readonly code: string | undefined;

  constructor(step: PrepStepId, cause: unknown) {
    super(`Prep step "${step}" failed: ${(cause as Error).message}`, { cause });
    const code = (cause as { code?: unknown } | null)?.code;
    this.code = typeof code === 'string' ? code : undefined;
    this.name = 'PrepStepFailedError';
    Object.setPrototypeOf(this, PrepStepFailedError.prototype);
  }
}

/**
 * Run all prep steps defined in the config, in order.
 * Accumulates long-running resources (serve, build) in the PrepContext for teardown.
 */
export async function runPrepSteps(
  config: DappTestConfig,
  dappDir: string,
  ctx: PrepContext,
  callbacks: PrepCallbacks,
): Promise<PrepStepResult[]> {
  const results: PrepStepResult[] = [];

  for (const step of config.prep) {
    throwIfCancelled(ctx.signal);
    const start = Date.now();
    callbacks.onStepStart(step);

    try {
      await runStep(step, config, dappDir, ctx, callbacks);
      const duration = Date.now() - start;
      results.push({ step, status: 'pass', duration });
      callbacks.onStepComplete(step, 'pass', duration);
    } catch (err) {
      const duration = Date.now() - start;
      const error = (err as Error).message;
      results.push({ step, status: 'fail', duration, error });
      callbacks.onStepComplete(step, 'fail', duration, error);
      throw new PrepStepFailedError(step, err);
    }
  }

  return results;
}

// ── Step dispatch ──

async function runStep(
  step: PrepStepId,
  config: DappTestConfig,
  dappDir: string,
  ctx: PrepContext,
  callbacks: PrepCallbacks,
): Promise<void> {
  if (step === 'cache-clear') {
    return stepCacheClear(config, ctx.root);
  }
  if (step === 'localnet-up') {
    return stepLocalnetUp(config, ctx, callbacks);
  }
  if (step.startsWith('balance:')) {
    const amount = parseInt(step.split(':')[1], 10);
    return stepBalance(amount, config, ctx, callbacks);
  }
  if (step === 'dust' || step === 'dust-register' || step === 'dust-wait') {
    return stepDust(config, ctx, callbacks);
  }
  if (step === 'mn-serve') {
    return stepMnServe(config, ctx, callbacks);
  }
  if (step === 'build-and-serve') {
    return stepBuildAndServe(config, dappDir, ctx, callbacks);
  }

  throw new Error(`Unknown prep step: ${step}`);
}

// ── Step implementations ──

async function stepCacheClear(config: DappTestConfig, root: string): Promise<void> {
  const network = config.network ?? 'undeployed';
  // Clear ALL wallet caches for this network — not just the active wallet.
  // After a localnet restart, every wallet (including genesis) has stale state.
  clearWalletCache(undefined, network, root);
}

async function stepLocalnetUp(config: DappTestConfig, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  // The step requires a running ledger-9 stack at the resolved endpoints
  // (`mn localnet up` starts one); it doesn't start one itself.
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
    configDir: ctx.root,
  }, ctx.host.settings());
  await assertLedger9StackReachable(network, networkConfig);
  callbacks.onMessage(`Using the ledger-9 stack at ${networkConfig.node} (indexer ${networkConfig.indexer})`);
}

async function stepBalance(amount: number, config: DappTestConfig, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
    configDir: ctx.root,
  }, ctx.host.settings());
  // On a ledger-8 chain the SDK's sync would retry forever.
  await assertLedgerSupported(network, networkConfig);

  const walletConfig = await unlockWallet(resolveWalletPath(ctx.root), { root: ctx.root, host: ctx.host });
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];

  // Check current balance — use fresh cache since localnet may have restarted
  callbacks.onMessage('Checking balance...');
  const engine = await ctx.host.engines.load(sdkSetOf(network, ctx.root));
  const stopListening = ctx.sdkWarnings.listen((_tag, msg) => {
    callbacks.onMessage(`SDK: ${msg}`);
  });
  try {
    const balance = await engine.wallet.prepNightBalance({ seed: seedBuffer, root: ctx.root, notice: ctx.host.notice, network, networkConfig, address, signal: ctx.signal, onMessage: callbacks.onMessage });
    if (balance > 0n) {
      callbacks.onMessage(`Balance OK: ${balance}`);
      return;
    }
  } finally {
    stopListening();
  }

  // Balance is zero
  if (network !== 'undeployed') {
    throw new InsufficientBalanceError(
      `Wallet has 0 NIGHT on ${network}. Fund your wallet before running tests:\n` +
      `  mn airdrop ${amount}   (if faucet available)\n` +
      `  Or transfer NIGHT from another wallet.`
    );
  }

  // Undeployed (localnet) — auto-airdrop from genesis
  callbacks.onMessage(`Balance is 0. Airdropping ${amount} NIGHT from genesis...`);
  // The same genesis airdrop `mn airdrop` and `mn dev` fund through.
  await engine.wallet.airdrop({
    networkConfig,
    recipientAddress: address,
    amount: nightToMicro(amount),
    onSync(_applied, _highest) {},
    onDust(status) { callbacks.onMessage(`Dust: ${status}`); },
    onProving() { callbacks.onMessage('Generating ZK proof...'); },
    onSubmitting() { callbacks.onMessage('Submitting airdrop transaction...'); },
    onSyncWarning(_tag, msg) { callbacks.onMessage(`Syncing genesis... (${msg})`); },
    sdkWarnings: ctx.sdkWarnings,
    root: ctx.root,
    notice: ctx.host.notice,
  });

  callbacks.onMessage(`Airdropped ${amount} NIGHT`);
}

/** The port a dApp's page is served on when dapp.test.json names none (Vite's preview). */
const DEFAULT_DAPP_PORT = 4173;

const DUST_WAIT_TIMEOUT_MS = 90_000; // 90s for dust to become available after registration

async function stepDust(config: DappTestConfig, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
    configDir: ctx.root,
  }, ctx.host.settings());
  await assertLedgerSupported(network, networkConfig);

  const walletConfig = await unlockWallet(resolveWalletPath(ctx.root), { root: ctx.root, host: ctx.host });
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];

  // Keep the SDK's transient errors and RPC noise off the terminal while this runs.
  const stopListening = ctx.sdkWarnings.listen(undefined);
  try {
    const { dustAvailable } = await (await ctx.host.engines.load(sdkSetOf(network, ctx.root))).wallet.prepDust(
      { seed: seedBuffer, root: ctx.root, notice: ctx.host.notice, network, networkConfig, address, signal: ctx.signal, onMessage: callbacks.onMessage },
      DUST_WAIT_TIMEOUT_MS,
    );
    // Verify dust is actually available — don't trust silent timeouts
    if (!dustAvailable) {
      if (network !== 'undeployed') {
        throw new DustRequiredError(
          `Dust not available on ${network}. Register dust and wait for it to generate:\n` +
          `  mn dust register\n` +
          `  mn dust status   (check until dustAvailable: true)`
        );
      }
      throw new DustRequiredError(`Dust not available after ${DUST_WAIT_TIMEOUT_MS / 1000}s. The chain may be slow — try again.`);
    }
  } finally {
    stopListening();
  }
}

async function stepMnServe(config: DappTestConfig, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  callbacks.onMessage('Starting mn serve...');

  // startServeOrReuse probes the port first: if a compatible mn serve is
  // already running it gets reused (with a no-op stop), if a stale/wrong-
  // network serve owns the port we throw with an actionable message rather
  // than silently double-binding and falling back to whatever was there
  // before.
  const handle = await startServeOrReuse({
    root: ctx.root,
    host: ctx.host,
    port: undefined, // use default
    network: config.network,
    onMessage: (msg) => callbacks.onMessage(`[serve] ${msg}`),
    dustWaitMs: OWN_COMMAND_DUST_WAIT_MS,
    sdkWarnings: ctx.sdkWarnings,
    signal: ctx.signal,
    // The dApp's page connects from the browser the test drives; every other page is refused.
    allowedOrigins: dappPageOrigins(config),
  });

  ctx.serveHandle = handle;
  ctx.addCleanup(async () => handle.stop());
  callbacks.onMessage(`mn serve ready on port ${handle.port}`);
}

/** The URL the dApp's page is served on during a test, from dapp.test.json. */
function dappPageUrl(config: DappTestConfig): string {
  return config.url ?? `http://localhost:${config.port ?? DEFAULT_DAPP_PORT}/`;
}

/**
 * The browser origins the test's serve lets connect: the dApp page's, when
 * the test has one (it builds and serves the page, or names its URL), else
 * none.
 */
export function dappPageOrigins(config: DappTestConfig): string[] {
  return config.prep.includes('build-and-serve') || config.url !== undefined ? [originOfPage(dappPageUrl(config))] : [];
}

async function stepBuildAndServe(config: DappTestConfig, dappDir: string, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  if (!config.buildCmd) {
    callbacks.onMessage('No buildCmd in config, skipping build');
    return;
  }

  const port = config.port ?? DEFAULT_DAPP_PORT;
  const url = dappPageUrl(config);
  const logFile = join(dappDir, 'tests', 'results', `build_${Date.now()}.log`);

  const handle = await startBuild({
    dappDir,
    buildCmd: config.buildCmd,
    buildDir: config.buildDir,
    port,
    url,
    logFile,
    onMessage: (msg) => callbacks.onMessage(`[build] ${msg}`),
  });

  ctx.buildHandle = handle;
  ctx.addCleanup(async () => handle.stop());
}
