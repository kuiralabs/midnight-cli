// Where mn keeps wallets, and the one-time move of a wallet an early mn kept
// at ~/.midnight/wallet.json. No key derivation and no SDK here: the entry
// runs the migration on every start, before dispatch.

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_WALLET_FILENAME, WALLETS_DIR_NAME, DEFAULT_WALLET_NAME, DIR_MODE, FILE_MODE, loadCliConfig, saveCliConfig } from '@kuiralabs/midnight-cli-core';
/** The wallets folder under the state root `root`. */
export function getWalletsDir(root: string): string {
  return path.join(root, WALLETS_DIR_NAME);
}

/** Where an early mn kept its one wallet, under the state root `root`. */
export function getDefaultWalletPath(root: string): string {
  return path.join(root, DEFAULT_WALLET_FILENAME);
}

function ensureMidnightDir(root: string): void {
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
  }
}

export function ensureWalletsDir(root: string): void {
  ensureMidnightDir(root);
  const dir = getWalletsDir(root);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Migrate old ~/.midnight/wallet.json to ~/.midnight/wallets/default.json.
 * Silent, one-time migration, under the state root `root`. No-op if wallets/ already has files or old wallet doesn't exist.
 */
export function migrateOldWallet(root: string): void {
  const oldPath = getDefaultWalletPath(root);
  if (!fs.existsSync(oldPath)) return;

  const walletsDir = getWalletsDir(root);

  // If wallets/ already has files, don't migrate (user already using multi-wallet)
  if (fs.existsSync(walletsDir)) {
    const existing = fs.readdirSync(walletsDir).filter(f => f.endsWith('.json'));
    if (existing.length > 0) return;
  }

  // Ensure wallets directory exists
  ensureWalletsDir(root);

  // Move old wallet to wallets/default.json
  const newPath = path.join(walletsDir, `${DEFAULT_WALLET_NAME}.json`);
  fs.copyFileSync(oldPath, newPath);
  fs.chmodSync(newPath, FILE_MODE);
  fs.unlinkSync(oldPath);

  // Set active wallet to default
  const config = loadCliConfig(root);
  config.wallet = DEFAULT_WALLET_NAME;
  saveCliConfig(config, root);
}
