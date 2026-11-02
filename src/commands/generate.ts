// generate command — create a new wallet (DEPRECATED)
// Use "midnight wallet generate <name>" instead.
// Three modes: random mnemonic (default), --seed <hex>, --mnemonic "..."
// Legacy behavior: saves to ~/.midnight/wallet.json (or --output <file>)

import * as fs from 'fs';
import * as path from 'path';
import { type ParsedArgs, getFlag, hasFlag } from '@kuiralabs/midnight-cli-core/lib/argv';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { engineFor } from '@kuiralabs/midnight-cli-core/lib/engine';
import { resolveNetworkName } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { type WalletPublic, writeSealedWallet } from '../lib/wallet-config.ts';
import { passphraseForNewSecret } from '../lib/passphrase.ts';
import { parseSeedHex } from '../lib/seed-resolver.ts';
import { header, keyValue, divider, formatAddress } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, yellow, dim, green } from '@kuiralabs/midnight-cli-core/ui/colors';
import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';
import { getDefaultWalletPath } from '../lib/wallet-paths.ts';
import { throwIfCancelled } from '@kuiralabs/midnight-cli-core/lib/errors';

export default async function generateCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const networkName = resolveNetworkName({ args });
  const outputPath = getFlag(args, 'output');

  // Mutual exclusion: --seed and --mnemonic cannot both be specified.
  // Seed source precedence: --seed flag > MN_SEED env. MN_SEED keeps the seed off
  // argv, where `ps` would leak it to every user on the box (env is same-user only).
  const seedFlag = getFlag(args, 'seed');
  const envSeed = process.env.MN_SEED?.trim();
  const seedHex = seedFlag ?? (envSeed ? envSeed : undefined);
  const mnemonicStr = getFlag(args, 'mnemonic');

  if (seedHex !== undefined && mnemonicStr !== undefined) {
    throw new Error('Cannot specify both --seed and --mnemonic. Use one or the other.');
  }

  // Overwrite protection: check if target file already exists
  const targetPath = outputPath
    ? path.resolve(outputPath)
    : getDefaultWalletPath();

  if (fs.existsSync(targetPath) && !hasFlag(args, 'force')) {
    throw new Error(
      `Wallet file already exists: ${targetPath}\n` +
      `Use --force to overwrite, or --output <file> to save to a different path.`
    );
  }

  let seedBuffer: Buffer;
  let mnemonic: string | undefined;

  if (seedHex !== undefined) {
    // Mode: restore from seed
    seedBuffer = parseSeedHex(seedHex, seedFlag !== undefined ? '--seed' : 'MN_SEED');
  } else if (mnemonicStr !== undefined) {
    // Mode: restore from mnemonic
    if (!validateMnemonic(mnemonicStr, wordlist)) {
      throw new Error('Invalid BIP-39 mnemonic. Expected 12 or 24 words from the English wordlist.');
    }
    mnemonic = mnemonicStr;
    seedBuffer = Buffer.from(mnemonicToSeedSync(mnemonic));
  } else {
    // Mode: random (default)
    mnemonic = generateMnemonic(wordlist, 256); // 24 words
    seedBuffer = Buffer.from(mnemonicToSeedSync(mnemonic));
  }

  const addresses = (await engineFor(networkName)).keys.unshieldedAddresses(seedBuffer);
  const activeAddress = addresses[networkName];

  const config: WalletPublic = {
    addresses,
    createdAt: new Date().toISOString(),
  };
  const secrets = mnemonic ? { seed: seedBuffer.toString('hex'), mnemonic } : { seed: seedBuffer.toString('hex') };

  const passphrase = await passphraseForNewSecret(undefined, { signal: ctx.signal });
  // Cancelled while the passphrase was asked for: no wallet is written, and no new passphrase saved.
  throwIfCancelled(ctx.signal);
  const savedPath = writeSealedWallet(targetPath, config, secrets, passphrase, { overwrite: hasFlag(args, 'force') });

  // JSON mode
  if (hasFlag(args, 'json')) {
    const result: Record<string, unknown> = {
      addresses,
      activeAddress,
      activeNetwork: networkName,
      seed: seedBuffer.toString('hex'),
      file: savedPath,
      createdAt: config.createdAt,
    };
    if (mnemonic) result.mnemonic = mnemonic;
    ctx.output.result(result);
    return;
  }

  // Active address to stdout (pipeable)
  ctx.output.stdout(activeAddress + '\n');

  // Details to stderr
  ctx.output.stderr('\n' + header('Wallet Generated') + '\n\n');
  ctx.output.stderr(keyValue('Network', networkName) + '\n');
  ctx.output.stderr(keyValue('Address', formatAddress(activeAddress)) + '\n');
  ctx.output.stderr(keyValue('File', savedPath) + '\n');
  ctx.output.stderr('\n');

  if (mnemonic) {
    ctx.output.stderr(yellow(bold('  MNEMONIC (save securely!):')) + '\n');
    ctx.output.stderr(`  ${mnemonic}\n\n`);
  }

  ctx.output.stderr(yellow(bold('  SEED (hex):')) + '\n');
  ctx.output.stderr(`  ${seedBuffer.toString('hex')}\n\n`);

  ctx.output.stderr(divider() + '\n');
  ctx.output.stderr(dim('  Next: midnight info | midnight balance') + '\n\n');
  ctx.output.stderr(green('✓') + ' Wallet saved\n');
}
