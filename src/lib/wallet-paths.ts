// Where mn keeps wallets, and the one-time move of a wallet an early mn kept
// at ~/.midnight/wallet.json. No key derivation and no SDK here: the entry
// runs the migration on every start, before dispatch.

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_WALLET_FILENAME, WALLETS_DIR_NAME, DEFAULT_WALLET_NAME, DIR_MODE, FILE_MODE } from '@kuiralabs/midnight-cli-core/lib/constants';
import { loadCliConfig, saveCliConfig } from '@kuiralabs/midnight-cli-core/lib/cli-config';
import { stateRoot } from '@kuiralabs/midnight-cli-core/lib/state-root';

function getMidnightDir(): string {
  return stateRoot();
}

export function getWalletsDir(): string {
  return path.join(getMidnightDir(), WALLETS_DIR_NAME);
}

export function getDefaultWalletPath(): string {
  return path.join(getMidnightDir(), DEFAULT_WALLET_FILENAME);
}

function ensureMidnightDir(): void {
  const dir = getMidnightDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

export function ensureWalletsDir(): void {
  ensureMidnightDir();
  const dir = getWalletsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Migrate old ~/.midnight/wallet.json to ~/.midnight/wallets/default.json.
 * Silent, one-time migration. No-op if wallets/ already has files or old wallet doesn't exist.
 */
export function migrateOldWallet(): void {
  const oldPath = getDefaultWalletPath();
  if (!fs.existsSync(oldPath)) return;

  const walletsDir = getWalletsDir();

  // If wallets/ already has files, don't migrate (user already using multi-wallet)
  if (fs.existsSync(walletsDir)) {
    const existing = fs.readdirSync(walletsDir).filter(f => f.endsWith('.json'));
    if (existing.length > 0) return;
  }

  // Ensure wallets directory exists
  ensureWalletsDir();

  // Move old wallet to wallets/default.json
  const newPath = path.join(walletsDir, `${DEFAULT_WALLET_NAME}.json`);
  fs.copyFileSync(oldPath, newPath);
  fs.chmodSync(newPath, FILE_MODE);
  fs.unlinkSync(oldPath);

  // Set active wallet to default
  const config = loadCliConfig();
  config.wallet = DEFAULT_WALLET_NAME;
  saveCliConfig(config);
}
