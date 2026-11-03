// wallet command — manage named wallets
// Subcommands: generate, list, use, info, remove

import * as fs from 'fs';
import { type ParsedArgs, getFlag, hasFlag, isMinimalMode } from '@kuiralabs/midnight-cli-core/lib/argv';
import { UsageError, throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { resolveNetworkName } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { parseSeedHex } from '../lib/seed-resolver.ts';
import {
  loadWalletConfig,
  walletAddress,
  unlockWallet,
  protectAllWallets,
  setActiveWallet,
  listWallets,
  removeWallet,
  resolveWalletPath,
  getActiveWalletName,
} from '../lib/wallet-config.ts';
import { passphraseForNewSecret } from '../lib/passphrase.ts';
import { createWallet, walletFilePath, walletSecretFrom } from '../lib/wallet-create.ts';
import { coinKeyOfWallet, type ProtectorResult, type WalletCommandContext } from '../lib/wallet-protector.ts';
import { header, keyValue, divider, formatAddress } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, yellow, dim, green, teal } from '@kuiralabs/midnight-cli-core/ui/colors';
import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';

export default async function walletCommand(args: ParsedArgs, ctx: WalletCommandContext): Promise<void> {
  const subcommand = args.subcommand;

  switch (subcommand) {
    case 'generate':
      return walletGenerate(args, ctx);
    case 'list':
    case 'ls':
      return walletList(args, ctx);
    case 'use':
      return walletUse(args, ctx);
    case 'info':
      return walletInfo(args, ctx);
    case 'remove':
    case 'rm':
      return walletRemove(args, ctx);
    case 'seed':
      return walletSeed(args, ctx);
    case 'protect':
      return walletProtect(args, ctx);
    default:
      throw new UsageError(
        `Unknown wallet subcommand: "${subcommand ?? '(none)'}"\n` +
        `Available: generate, list, use, info, remove, seed, protect\n` +
        `Run "midnight help wallet" for usage.`
      );
  }
}

async function walletGenerate(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const name = args.positionals[0];
  if (!name) {
    throw new Error(
      'Missing wallet name.\nUsage: midnight wallet generate <name> [--network <name>]'
    );
  }

  const root = ctx.config.paths.stateRoot;
  const targetPath = walletFilePath(root, name);

  const networkName = resolveNetworkName({ args, configDir: root });
  const seedHex = getFlag(args, 'seed');
  const mnemonicStr = getFlag(args, 'mnemonic');

  if (seedHex !== undefined && mnemonicStr !== undefined) {
    throw new Error('Cannot specify both --seed and --mnemonic. Use one or the other.');
  }

  if (fs.existsSync(targetPath) && !hasFlag(args, 'force')) {
    throw new Error(
      `Wallet "${name}" already exists: ${targetPath}\n` +
      `Use --force to overwrite.`
    );
  }

  const secret = walletSecretFrom(seedHex !== undefined ? { seed: parseSeedHex(seedHex, '--seed') } : { mnemonic: mnemonicStr });

  const passphrase = await passphraseForNewSecret(ctx.host, root, { signal: ctx.signal });
  // Cancelled while the passphrase was asked for: no wallet is written, and no new passphrase saved.
  throwIfCancelled(ctx.signal);
  // Checked above: an existing wallet is replaced only with --force.
  const created = await createWallet(root, name, secret, passphrase, { overwrite: hasFlag(args, 'force') });
  const { addresses, shieldedAddresses, mnemonic, file: savedPath } = created;
  const seedBuffer = created.seed;
  const activeAddress = addresses[networkName];

  // JSON mode
  if (hasFlag(args, 'json')) {
    const result: Record<string, unknown> = {
      name,
      addresses,
      shieldedAddresses,
      activeAddress,
      activeNetwork: networkName,
      seed: seedBuffer.toString('hex'),
      file: savedPath,
      createdAt: created.createdAt,
      active: true,
    };
    if (mnemonic) result.mnemonic = mnemonic;
    ctx.output.result(result);
    return;
  }

  // Active address to stdout (pipeable)
  ctx.output.stdout(activeAddress + '\n');

  // Details to stderr
  ctx.output.stderr('\n' + header('Wallet Generated') + '\n\n');
  ctx.output.stderr(keyValue('Name', name) + '\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n');
  ctx.output.stderr(keyValue('Address', formatAddress(activeAddress)) + '\n');
  const activeShielded = shieldedAddresses[networkName];
  if (activeShielded) {
    ctx.output.stderr(keyValue('Shielded', formatAddress(activeShielded)) + '\n');
  }
  ctx.output.stderr(keyValue('File', savedPath) + '\n');
  ctx.output.stderr(keyValue('Active', 'yes') + '\n');
  ctx.output.stderr('\n');

  if (mnemonic) {
    ctx.output.stderr(yellow(bold('  MNEMONIC (save securely!):')) + '\n');
    ctx.output.stderr(`  ${mnemonic}\n\n`);
  }

  ctx.output.stderr(yellow(bold('  SEED (hex):')) + '\n');
  ctx.output.stderr(`  ${seedBuffer.toString('hex')}\n\n`);

  ctx.output.stderr(divider() + '\n');
  ctx.output.stderr(dim('  Next: midnight wallet list | midnight balance') + '\n\n');
  ctx.output.stderr(green('✓') + ' Wallet saved\n');
}

async function walletList(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const root = ctx.config.paths.stateRoot;
  const wallets = await listWallets(root);
  const networkName = resolveNetworkName({ args, configDir: root });

  if (hasFlag(args, 'json')) {
    // Agent-slim shape: per-wallet { name, active, network, address,
    // shieldedAddress } scoped to the active network. Triggered by
    // captureCommand injecting _minimal for MCP calls. Tool exposes
    // `full: true` (→ _full flag) to opt back into the human shape.
    if (isMinimalMode(args)) {
      ctx.output.result({
        activeNetwork: networkName,
        wallets: wallets.map((w) => ({
          name: w.name,
          active: w.isActive,
          network: networkName,
          address: w.addresses[networkName] ?? null,
          shieldedAddress: w.shieldedAddresses?.[networkName] ?? null,
        })),
      });
      return;
    }
    ctx.output.result({
      activeNetwork: networkName,
      wallets: wallets.map((w) => ({
        name: w.name,
        active: w.isActive,
        addresses: w.addresses,
        shieldedAddresses: w.shieldedAddresses,
        createdAt: w.createdAt,
        file: w.file,
      })),
    });
    return;
  }

  if (wallets.length === 0) {
    ctx.output.stderr('\n  No wallets found.\n');
    ctx.output.stderr(dim('  Create one: midnight wallet generate <name> --network <name>') + '\n\n');
    return;
  }

  ctx.output.stderr('\n' + header('Wallets') + '\n\n');

  // Compact one-line layout — name + truncated unshielded + truncated shielded.
  // Columns padded to the widest entry so addresses align. Full per-network
  // detail (untruncated, all 3 networks) lives in `mn wallet info <name>`.
  const nameWidth = Math.max(...wallets.map((w) => w.name.length));
  const ADDR_WIDTH = 19;     // formatAddress(_, true) renders as `<10>…<8>` = 19 chars
  const SHIELDED_WIDTH = 19; // same truncation rule

  // Header row
  const namePad = ' '.repeat(nameWidth - 'name'.length);
  ctx.output.stderr(
    `    ${dim('name')}${namePad}  ${dim('unshielded'.padEnd(ADDR_WIDTH))}  ${dim('shielded')}\n`,
  );

  for (const w of wallets) {
    const marker = w.isActive ? green('●') : ' ';
    const nameStr = w.isActive ? bold(teal(w.name)) : teal(w.name);
    const padding = ' '.repeat(nameWidth - w.name.length);
    const unshielded = w.addresses[networkName] ?? '(unknown)';
    const shielded = w.shieldedAddresses?.[networkName];
    const shieldedCell = shielded ? formatAddress(shielded, true) : dim('—'.padEnd(SHIELDED_WIDTH));
    ctx.output.stderr(
      `  ${marker} ${nameStr}${padding}  ${formatAddress(unshielded, true)}  ${shieldedCell}\n`,
    );
  }

  ctx.output.stderr('\n' + divider() + '\n');
  ctx.output.stderr(dim(`  ● = active wallet · network: ${networkName} · details: midnight wallet info <name>`) + '\n\n');
}

async function walletUse(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const name = args.positionals[0];
  if (!name) {
    throw new Error(
      'Missing wallet name.\nUsage: midnight wallet use <name>'
    );
  }

  setActiveWallet(ctx.config.paths.stateRoot, name);

  if (hasFlag(args, 'json')) {
    ctx.output.result({ wallet: name, active: true });
    return;
  }

  ctx.output.stderr(green('✓') + ` Active wallet set to "${name}"\n`);
}

async function walletInfo(args: ParsedArgs, ctx: CallContext): Promise<void> {
  // Accept both `wallet info <name>` (positional) and `wallet info --wallet <name>`
  // (flag, consistent with balance/dust/transfer); fall back to the active wallet.
  const root = ctx.config.paths.stateRoot;
  const name = getFlag(args, 'wallet') ?? args.positionals[0] ?? getActiveWalletName(root);
  const walletPath = resolveWalletPath(root, name);
  const config = await loadWalletConfig(walletPath);
  const isActive = name === getActiveWalletName(root);
  const networkName = resolveNetworkName({ args, configDir: root });
  const activeAddress = await walletAddress(walletPath, networkName, root, ctx.host);

  if (hasFlag(args, 'json')) {
    // Agent-slim shape: drops the per-network addresses map (3× repetition
    // of long strings) and bookkeeping fields. Agents pass `full: true` to
    // get the human shape (per-network maps, createdAt, file).
    if (isMinimalMode(args)) {
      ctx.output.result({
        name,
        active: isActive,
        network: networkName,
        address: activeAddress,
        shieldedAddress: config.shieldedAddresses?.[networkName] ?? null,
      });
      return;
    }
    const result: Record<string, unknown> = {
      name,
      addresses: config.addresses,
      activeAddress,
      activeNetwork: networkName,
      createdAt: config.createdAt,
      file: walletPath,
      active: isActive,
    };
    if (config.shieldedAddresses) result.shieldedAddresses = config.shieldedAddresses;
    ctx.output.result(result);
    return;
  }

  // Bare active address to stdout (pipeable)
  ctx.output.stdout(activeAddress + '\n');

  // Header with wallet name inline
  ctx.output.stderr('\n' + header(`Wallet: ${name}`) + '\n\n');

  // Per-network grouping — unshielded + shielded together
  const networks = Object.keys(config.addresses) as Array<keyof typeof config.addresses>;
  for (let i = 0; i < networks.length; i++) {
    const network = networks[i] as string;
    const isActiveNet = network === networkName;
    const unshielded = config.addresses[network as keyof typeof config.addresses];
    const shielded = config.shieldedAddresses?.[network as keyof typeof config.addresses];

    const label = isActiveNet ? bold(teal(network)) + dim('  (active)') : network;
    ctx.output.stderr(`  ${label}\n`);
    ctx.output.stderr(`    ${dim('unshielded')}  ${formatAddress(unshielded as string)}\n`);
    if (shielded) {
      ctx.output.stderr(`    ${dim('shielded  ')}  ${formatAddress(shielded)}\n`);
    } else {
      ctx.output.stderr(`    ${dim('shielded  ')}  ${dim('(unavailable)')}\n`);
    }
    if (i < networks.length - 1) ctx.output.stderr('\n');
  }

  // Footer
  ctx.output.stderr('\n' + divider() + '\n\n');
  ctx.output.stderr(`  ${dim('created')}  ${config.createdAt}\n`);
  ctx.output.stderr(`  ${dim('file   ')}  ${walletPath}\n`);
  ctx.output.stderr(`  ${dim('active ')}  ${isActive ? green('yes') : 'no'}\n\n`);
}

async function walletRemove(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const name = args.positionals[0];
  if (!name) {
    throw new Error(
      'Missing wallet name.\nUsage: midnight wallet remove <name>'
    );
  }

  removeWallet(ctx.config.paths.stateRoot, name);

  if (hasFlag(args, 'json')) {
    ctx.output.result({ wallet: name, removed: true });
    return;
  }

  ctx.output.stderr(green('✓') + ` Wallet "${name}" removed\n`);
}

async function walletSeed(args: ParsedArgs, ctx: CallContext): Promise<void> {
  // Accept both `wallet seed <name>` and `wallet seed --wallet <name>`.
  const root = ctx.config.paths.stateRoot;
  const name = getFlag(args, 'wallet') ?? args.positionals[0] ?? getActiveWalletName(root);
  const walletPath = resolveWalletPath(root, name);

  // The seed and mnemonic, opened with mn's passphrase.
  const raw = await unlockWallet(walletPath, { root, host: ctx.host });

  // `--entropy` adds the 32-byte BIP-39 entropy (derived from the mnemonic)
  // alongside the 64-byte PBKDF2 seed. They're DIFFERENT values that produce
  // DIFFERENT Midnight wallets — use the format your target project expects.
  const includeEntropy = hasFlag(args, 'entropy');
  let entropyHex: string | undefined;
  if (includeEntropy) {
    if (!raw.mnemonic) {
      throw new Error(
        `Wallet "${name}" has no mnemonic on file — cannot derive BIP-39 entropy.\n` +
        `The 32-byte entropy can only be computed from the original 24-word mnemonic.`,
      );
    }
    entropyHex = Buffer.from(mnemonicToEntropy(raw.mnemonic, wordlist)).toString('hex');
  }

  // JSON mode — no interactive prompt, just output
  if (hasFlag(args, 'json')) {
    const result: Record<string, unknown> = { name, seed: raw.seed };
    if (raw.mnemonic) result.mnemonic = raw.mnemonic;
    if (entropyHex) result.entropy = entropyHex;
    ctx.output.result(result);
    return;
  }

  // Warning + confirmation
  ctx.output.stderr('\n');
  ctx.output.stderr(yellow(bold('  ⚠ WARNING: This will display your wallet seed and mnemonic.')) + '\n');
  ctx.output.stderr(yellow('  Anyone with this seed can access your funds.') + '\n');
  ctx.output.stderr(yellow('  Never share it. Never paste it into a website.') + '\n');
  ctx.output.stderr('\n');

  const confirmed = await confirm('  Show seed? (y/N) ');
  if (!confirmed) {
    ctx.output.stderr(dim('  Cancelled.') + '\n\n');
    return;
  }

  // Seed to stdout (pipeable)
  ctx.output.stdout(raw.seed + '\n');

  // Details to stderr
  ctx.output.stderr('\n');
  ctx.output.stderr(keyValue('Name', name) + '\n');
  ctx.output.stderr(keyValue('Seed (64-byte PBKDF2)', raw.seed) + '\n');
  if (entropyHex) {
    ctx.output.stderr(keyValue('Entropy (32-byte BIP-39)', entropyHex) + '\n');
  }
  if (raw.mnemonic) {
    ctx.output.stderr(keyValue('Mnemonic', raw.mnemonic) + '\n');
  }
  ctx.output.stderr(keyValue('File', walletPath) + '\n');
  if (entropyHex) {
    ctx.output.stderr('\n');
    ctx.output.stderr(dim('  Note: seed and entropy derive DIFFERENT Midnight wallets from the') + '\n');
    ctx.output.stderr(dim('  same mnemonic. Use the value your target project accepts.') + '\n');
  }
  ctx.output.stderr('\n');
}

/** Sets mn's passphrase where none is set, and seals every plain-text wallet under it. */
async function walletProtect(args: ParsedArgs, ctx: WalletCommandContext): Promise<void> {
  const root = ctx.config.paths.stateRoot;
  const passphrase = await passphraseForNewSecret(ctx.host, root, { signal: ctx.signal });
  // Cancelled, it stops between wallets and before a protector, never in the middle of a file.
  const report = await protectAllWallets(root, passphrase, ctx.signal);
  const sealed = report.filter((w) => w.sealedNow).map((w) => w.name);
  const alreadySealed = report.filter((w) => !w.sealedNow).map((w) => w.name);
  // What other domains keep for a wallet, sealed by the protectors the caller gave; each is told how to get a wallet's coin key.
  const results: Array<{ name: string; result: ProtectorResult }> = [];
  for (const protector of ctx.protectors ?? []) {
    throwIfCancelled(ctx.signal);
    results.push({ name: protector.name, result: await protector.protect(root, passphrase, (wallet) => coinKeyOfWallet(root, ctx.host, wallet)) });
  }
  if (hasFlag(args, 'json')) {
    ctx.output.result({ sealed, alreadySealed, ...Object.fromEntries(results.map(({ name, result }) => [name, result.report])) });
    return;
  }
  ctx.output.stderr('\n');
  for (const name of sealed) ctx.output.stderr(green(`  ✓ ${name}: encrypted`) + '\n');
  for (const name of alreadySealed) ctx.output.stderr(dim(`  ${name}: already encrypted`) + '\n');
  if (report.length === 0) ctx.output.stderr(dim('  No wallets yet: each new wallet is encrypted under this passphrase.') + '\n');
  for (const item of results.flatMap(({ result }) => result.items)) {
    if ('error' in item) ctx.output.stderr(yellow(`  ✗ ${item.subject}: not encrypted: ${item.error}`) + '\n');
    else if (item.outcome === 'sealed-now') ctx.output.stderr(green(`  ✓ ${item.subject}: ${item.sealedNote}`) + '\n');
    else ctx.output.stderr(dim(`  ${item.subject}: already encrypted`) + '\n');
  }
  ctx.output.stderr('\n' + dim('  Keep the passphrase safe: without it, mn cannot open these wallets.') + '\n\n');
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
