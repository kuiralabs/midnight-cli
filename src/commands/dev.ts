// `mn dev` — iteration loop for Compact contract development.
// M1: detect project → ensure localnet → watch .compact → compile on save.
// M2: `d` keypress deploys the current compiled artifact, `q` quits cleanly.

import { resolve, relative } from 'node:path';
import { type ParsedArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { payerFor } from '@kuiralabs/midnight-cli-core/lib/payer';
import type { CallContext, CallOutput } from '@kuiralabs/midnight-cli-core/lib/call-context';
import { isPassphraseSet, unlockPassphrase } from '../lib/passphrase.ts';
import { detectProject, type ProjectInfo } from '../lib/dev/detect-project.ts';
import { runCompile, type CompileResult } from '../lib/dev/compile.ts';
import { runTests } from '../lib/dev/test.ts';
import { startWatching, type WatchHandle } from '../lib/dev/watch.ts';
import { ensureLocalnetRunning } from '../lib/dev/localnet-ready.ts';
import {
  provisionDevWallets,
  DEFAULT_DEV_WALLET_NAMES,
  DEFAULT_DEV_AIRDROP_AMOUNT,
} from '../lib/dev/provision-wallets.ts';
import { startKeyDispatcher } from '../ui/dev-keys.ts';
import { findWitnessFile, buildMissingWitnessError } from '../lib/contract/witness-discovery.ts';
import { header, divider, keyValue } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, dim, red, teal, yellow } from '@kuiralabs/midnight-cli-core/ui/colors';


/** Wallet used when `d` deploys. Must be one of the provisioned dev-* names. */
const DEPLOY_WALLET = 'dev-alice';
const DEPLOY_NETWORK = 'undeployed';

export default async function devCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const { signal } = ctx;
  const startDir = resolve(args.positionals[0] ?? process.cwd());

  ctx.output.stderr('\n' + header('mn dev') + '\n\n');

  // ── Phase 1: detect project ───────────────────────────────
  const project: ProjectInfo = detectProject(startDir);

  if (!project.compileScript) {
    throw new Error(
      `No compile script found in ${project.projectRoot}/package.json.\n` +
      `mn dev looks for a "compact" or "compile" npm script that invokes the\n` +
      `Compact toolchain. Add one of:\n` +
      `  "scripts": { "compact": "compact compile src/my.compact src/managed/my" }\n` +
      `  "scripts": { "compile": "compact compile src/my.compact src/managed/my" }\n` +
      `create-mn-app and midnight-starship templates ship with this already wired.`,
    );
  }

  ctx.output.stderr(keyValue('Project', project.projectRoot) + '\n');
  ctx.output.stderr(keyValue('Sources', `${project.sourceFiles.length} .compact file(s)`) + '\n');
  ctx.output.stderr(keyValue('Compile', `npm run ${project.compileScript}`) + '\n\n');

  // ── Phase 2: ensure localnet running ──────────────────────
  const localnetSpinner = ctx.progress.start('Checking localnet...');
  try {
    const result = await ensureLocalnetRunning(ctx.config.paths.stateRoot, (msg) => localnetSpinner.update(msg));
    const stateLabel = {
      'already-running': 'Ledger-9 stack reachable',
    }[result.state];
    localnetSpinner.stop(stateLabel);
  } catch (err) {
    localnetSpinner.fail('Localnet setup failed');
    throw err;
  }

  // ── Phase 3: provision dev wallets ────────────────────────
  const walletSpinner = ctx.progress.start('Provisioning dev wallets...');
  try {
    const provisioned = await provisionDevWallets({
      root: ctx.config.paths.stateRoot,
      names: DEFAULT_DEV_WALLET_NAMES,
      amountNight: DEFAULT_DEV_AIRDROP_AMOUNT,
      signal,
      sdkWarnings: ctx.sdkWarnings,
      onProgress: (name, phase) => {
        const label = {
          creating: 'generating',
          funding: 'airdropping',
          dust: 'registering dust',
          done: 'ready',
        }[phase];
        walletSpinner.update(`${name}: ${label}`);
      },
    });
    const created = provisioned.filter((w) => w.state === 'created').length;
    const reused = provisioned.length - created;
    const summary = [
      created ? `${created} created` : '',
      reused ? `${reused} reused` : '',
    ].filter(Boolean).join(', ');
    walletSpinner.stop(`Dev wallets: ${provisioned.map((w) => w.name).join(', ')} (${summary})`);
  } catch (err) {
    walletSpinner.fail('Wallet provisioning failed');
    throw err;
  }

  // Shared state threaded through the watcher and keypress handlers.
  let lastCompile: CompileResult | null = null;
  let deployInFlight = false;
  let testInFlight = false;
  let compileInFlight = false;
  let compileQueued = false;

  // ── Phase 4: first compile pass ───────────────────────────
  lastCompile = await compileAndReport(project, ctx);
  if (!lastCompile.success) {
    ctx.output.stderr(dim('\n  Fix the errors above and save — mn dev will recompile automatically.\n'));
  }

  // ── Phase 5: start watcher ────────────────────────────────
  const runPass = async () => {
    if (deployInFlight || testInFlight) {
      // Another exclusive action is holding the line. The save will be picked
      // up after it returns — the user can always save again to force a recompile.
      return;
    }
    if (compileInFlight) {
      compileQueued = true;
      return;
    }
    compileInFlight = true;
    try {
      lastCompile = await compileAndReport(project, ctx);
    } finally {
      compileInFlight = false;
      if (compileQueued) {
        compileQueued = false;
        // Drain queued request after in-flight finishes.
        runPass();
      }
    }
  };

  const watcher: WatchHandle = startWatching({
    dirs: project.sourceDirs,
    extension: '.compact',
    onChange: async (changed) => {
      const rel = changed.map((p) => relative(project.projectRoot, p)).join(', ');
      ctx.output.stderr('\n' + dim(`  Changed: ${rel}`) + '\n');
      await runPass();
    },
    onError: (err) => {
      ctx.output.stderr(red('  watch error: ') + err.message + '\n');
    },
  });

  ctx.output.stderr('\n' + divider() + '\n');
  const watchedLabel = project.sourceDirs.map((d) => relative(project.projectRoot, d) || '.').join(', ');
  ctx.output.stderr(dim('  Watching ') + teal(watchedLabel) + dim(' — save to recompile.') + '\n');
  const testHint = project.testScript ? bold('[t]') + dim(` test (${project.testScript})   `) : '';
  ctx.output.stderr(dim('  ') + bold('[d]') + dim(' deploy   ') + testHint + bold('[q]') + dim(' quit\n\n'));

  // ── Phase 6: keystroke dispatcher + wait until aborted ────
  // Unlock mn's passphrase now, while stdin is still a plain terminal: once the
  // dispatcher reads keys in raw mode, a passphrase typed for [d]'s deploy would
  // be read as dev keystrokes too. Asked once per run; MN_PASSPHRASE asks nothing.
  if (isPassphraseSet(ctx.config.paths.stateRoot)) await unlockPassphrase(ctx.config.paths.stateRoot);

  const abortController = new AbortController();
  const stopRequest = () => {
    if (!abortController.signal.aborted) abortController.abort();
  };

  const keys = startKeyDispatcher({
    actions: {
      d: async () => {
        if (deployInFlight) {
          ctx.output.stderr(dim('  Deploy already in flight — ignoring key press.\n'));
          return;
        }
        if (testInFlight) {
          ctx.output.stderr(dim('  Tests are running — wait for them to finish before deploying.\n'));
          return;
        }
        if (!lastCompile?.success) {
          ctx.output.stderr(yellow('  Cannot deploy — last compile did not succeed. Fix and save first.\n'));
          return;
        }
        deployInFlight = true;
        try {
          await deployContract(project, ctx);
        } finally {
          deployInFlight = false;
        }
      },
      t: async () => {
        if (testInFlight) {
          ctx.output.stderr(dim('  Tests already in flight — ignoring key press.\n'));
          return;
        }
        if (deployInFlight) {
          ctx.output.stderr(dim('  Deploy in flight — wait for it to finish before running tests.\n'));
          return;
        }
        if (!project.testScript) {
          ctx.output.stderr(yellow('  No test script found. Add "test:dev" or "test" to package.json.\n'));
          return;
        }
        if (!lastCompile?.success) {
          ctx.output.stderr(yellow('  Cannot run tests — last compile did not succeed. Fix and save first.\n'));
          return;
        }
        testInFlight = true;
        try {
          await runProjectTests(ctx.output, project, abortController.signal);
        } finally {
          testInFlight = false;
        }
      },
      q: () => stopRequest(),
    },
    onInterrupt: stopRequest,
  });

  await new Promise<void>((resolvePromise) => {
    const onAbort = () => {
      keys.stop();
      watcher.stop();
      ctx.output.stderr('\n' + dim('  mn dev stopped.') + '\n');
      resolvePromise();
    };
    if (abortController.signal.aborted) { onAbort(); return; }
    abortController.signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { stopRequest(); return; }
    signal?.addEventListener('abort', stopRequest, { once: true });
  });
}

async function deployContract(project: ProjectInfo, ctx: CallContext): Promise<void> {
  // Pre-flight: contracts that declare witnesses need a witnesses.js the
  // runner can load. If declared witnesses exist and no implementation file
  // is present, refuse early with an actionable message rather than letting
  // the SDK throw "first (witnesses) argument does not contain a function-
  // valued field named X" mid-deploy.
  const witnessNames = await readDeclaredWitnesses(project.projectRoot);
  if (witnessNames.length > 0 && !findWitnessFile(project.projectRoot)) {
    const message = buildMissingWitnessError({ projectRoot: project.projectRoot, witnessNames });
    ctx.output.stderr(yellow(`  ✗ Cannot auto-deploy:\n`));
    for (const line of message.split('\n')) ctx.output.stderr(dim(`    ${line}\n`));
    return;
  }

  const spinner = ctx.progress.start(`Deploying with ${DEPLOY_WALLET} on ${DEPLOY_NETWORK}...`);
  try {
    const { deployDevContract } = await import('../lib/dev/deploy.ts');
    // The payer is the caller's (the CLI passes the serve payer), as for contract and grant.
    const deployed = await deployDevContract(ctx.config.paths.stateRoot, project.projectRoot, DEPLOY_WALLET, DEPLOY_NETWORK, payerFor('dev deploy', ctx), ctx.progress.silent(), ctx.sdkWarnings, ctx.signal);
    spinner.stop(`Deployed`);
    ctx.output.stderr(`  ${dim('address')}  ${teal(deployed.address)}\n`);
  } catch (err) {
    spinner.fail('Deploy failed');
    const message = err instanceof Error ? err.message : String(err);
    ctx.output.stderr(red('  ' + message) + '\n');
  }
}

async function runProjectTests(output: CallOutput, project: ProjectInfo, signal?: AbortSignal): Promise<void> {
  output.stderr(dim(`\n  Running npm run ${project.testScript}...\n`));
  try {
    // runTests passes cwd: project.projectRoot to spawn — no parent chdir needed.
    // The tests stream their output to this terminal as they run.
    const result = await runTests({ project, signal, output: 'inherit' });
    if (result.success) {
      output.stderr(`  ${dim('─')} Tests passed ${dim(`(${formatDuration(result.durationMs)})`)}\n`);
    } else {
      output.stderr(`  ${dim('─')} ${red(`Tests failed`)} ${dim(`(exit ${result.exitCode}, ${formatDuration(result.durationMs)})`)}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.stderr(red('  Test runner error: ') + message + '\n');
  }
}

/**
 * Returns the names of witnesses declared in the project's compiled contract,
 * or an empty array if no compiled artifact / witnesses exist.
 * Best-effort — failures (no managed dir yet, malformed info) → empty array.
 */
async function readDeclaredWitnesses(projectRoot: string): Promise<string[]> {
  try {
    const { findContractInfo } = await import('../lib/contract/inspect.ts');
    const { info } = findContractInfo(projectRoot);
    return info.witnesses.map((w) => w.name);
  } catch {
    return [];
  }
}

async function compileAndReport(project: ProjectInfo, ctx: CallContext): Promise<CompileResult> {
  const spinner = ctx.progress.start('Compiling...');
  try {
    const result = await runCompile({ project, signal: ctx.signal });
    if (result.success) {
      spinner.stop(`Compiled ${dim(`(${formatDuration(result.durationMs)})`)}`);
    } else {
      spinner.fail(`Compile failed ${dim(`(${formatDuration(result.durationMs)})`)}`);
      if (result.stderr.trim()) {
        ctx.output.stderr(dim('  ─ stderr ─') + '\n');
        ctx.output.stderr(yellow(indent(result.stderr.trim(), '  ')) + '\n');
      }
    }
    return result;
  } catch (err) {
    spinner.fail('Compile error');
    const message = err instanceof Error ? err.message : String(err);
    ctx.output.stderr(red('  ' + message) + '\n');
    return {
      success: false,
      durationMs: 0,
      command: '',
      stdout: '',
      stderr: message,
      exitCode: -1,
    };
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((line) => prefix + line).join('\n');
}
