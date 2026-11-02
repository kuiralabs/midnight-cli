// Prep runner — execute prep steps defined in dapp.test.json by calling existing lib functions.

import { join } from 'node:path';

import { clearWalletCache } from '../wallet-cache.ts';
import { resolveWalletPath, unlockWallet } from '../wallet-config.ts';
import { resolveNetwork } from '../resolve-network.ts';
import type { NetworkConfig, NetworkName } from '../network.ts';
import { assertLedger9StackReachable, assertLedgerSupported } from '../ledger-guard.ts';

import type { DappTestConfig, PrepStepId, PrepStepResult, PrepContext, PrepCallbacks } from './types.ts';
import { startServeOrReuse } from '../serve-manager.ts';
import { OWN_COMMAND_DUST_WAIT_MS } from '../dust-wait.ts';
import { startBuild } from './build-manager.ts';
import { throwIfCancelled } from '../errors.ts';
import { engineFor } from '../engine.ts';

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
      throw new Error(`Prep step "${step}" failed: ${error}`);
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
    return stepCacheClear(config);
  }
  if (step === 'localnet-up') {
    return stepLocalnetUp(config, callbacks);
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

async function stepCacheClear(config: DappTestConfig): Promise<void> {
  const network = config.network ?? 'undeployed';
  // Clear ALL wallet caches for this network — not just the active wallet.
  // After a localnet restart, every wallet (including genesis) has stale state.
  clearWalletCache(undefined, network);
}

async function stepLocalnetUp(config: DappTestConfig, callbacks: PrepCallbacks): Promise<void> {
  // This build can't start a localnet (no published ledger-9 indexer image),
  // so the step requires a running ledger-9 stack at the resolved endpoints.
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
  });
  await assertLedger9StackReachable(network, networkConfig);
  callbacks.onMessage(`Using the ledger-9 stack at ${networkConfig.node} (indexer ${networkConfig.indexer})`);
}

async function stepBalance(amount: number, config: DappTestConfig, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
  });
  // On a ledger-8 chain the SDK's sync would retry forever.
  await assertLedgerSupported(network, networkConfig);

  const walletConfig = await unlockWallet(resolveWalletPath());
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];

  // Check current balance — use fresh cache since localnet may have restarted
  callbacks.onMessage('Checking balance...');
  const engine = await engineFor(network);
  const stopListening = ctx.sdkWarnings.listen((_tag, msg) => {
    callbacks.onMessage(`SDK: ${msg}`);
  });
  try {
    const balance = await engine.wallet.prepNightBalance({ seed: seedBuffer, network, networkConfig, address, signal: ctx.signal, onMessage: callbacks.onMessage });
    if (balance > 0n) {
      callbacks.onMessage(`Balance OK: ${balance}`);
      return;
    }
  } finally {
    stopListening();
  }

  // Balance is zero
  if (network !== 'undeployed') {
    throw new Error(
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
    amountNight: amount,
    onSync(_applied, _highest) {},
    onDust(status) { callbacks.onMessage(`Dust: ${status}`); },
    onProving() { callbacks.onMessage('Generating ZK proof...'); },
    onSubmitting() { callbacks.onMessage('Submitting airdrop transaction...'); },
    onSyncWarning(_tag, msg) { callbacks.onMessage(`Syncing genesis... (${msg})`); },
    sdkWarnings: ctx.sdkWarnings,
  });

  callbacks.onMessage(`Airdropped ${amount} NIGHT`);
}

const DUST_WAIT_TIMEOUT_MS = 90_000; // 90s for dust to become available after registration

async function stepDust(config: DappTestConfig, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
  });
  await assertLedgerSupported(network, networkConfig);

  const walletConfig = await unlockWallet(resolveWalletPath());
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];

  // Keep the SDK's transient errors and RPC noise off the terminal while this runs.
  const stopListening = ctx.sdkWarnings.listen(undefined);
  try {
    const { dustAvailable } = await (await engineFor(network)).wallet.prepDust(
      { seed: seedBuffer, network, networkConfig, address, signal: ctx.signal, onMessage: callbacks.onMessage },
      DUST_WAIT_TIMEOUT_MS,
    );
    // Verify dust is actually available — don't trust silent timeouts
    if (!dustAvailable) {
      if (network !== 'undeployed') {
        throw new Error(
          `Dust not available on ${network}. Register dust and wait for it to generate:\n` +
          `  mn dust register\n` +
          `  mn dust status   (check until dustAvailable: true)`
        );
      }
      throw new Error(`Dust not available after ${DUST_WAIT_TIMEOUT_MS / 1000}s. The chain may be slow — try again.`);
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
    port: undefined, // use default
    network: config.network,
    onMessage: (msg) => callbacks.onMessage(`[serve] ${msg}`),
    dustWaitMs: OWN_COMMAND_DUST_WAIT_MS,
    sdkWarnings: ctx.sdkWarnings,
    signal: ctx.signal,
  });

  ctx.serveHandle = handle;
  ctx.addCleanup(async () => handle.stop());
  callbacks.onMessage(`mn serve ready on port ${handle.port}`);
}

async function stepBuildAndServe(config: DappTestConfig, dappDir: string, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  if (!config.buildCmd) {
    callbacks.onMessage('No buildCmd in config, skipping build');
    return;
  }

  const port = config.port ?? 4173;
  const url = config.url ?? `http://localhost:${port}/`;
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
