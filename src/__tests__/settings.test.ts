// The environment variables reach libraries only as settings their host
// gives them (or a caller passes): each maps to its setting, and a library
// given none behaves as if none were set, whatever the environment says.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsFromEnvironment } from '@kuiralabs/midnight-cli-core/lib/settings';
import { createHost } from '@kuiralabs/midnight-cli-core/lib/host';
import { resolveBlockfrostProjectId } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { detectLocalStacks } from '@kuiralabs/midnight-cli-core/lib/network';
import { parseArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { readPassphrase, passphraseForNewSecret, NoPassphraseError } from '../lib/passphrase.ts';
import { resolveSeedSource } from '../lib/seed-resolver.ts';

/** Runs `fn` with `name` set in the process's environment, then restores it. */
async function withProcessEnv(name: string, value: string, fn: () => Promise<void> | void): Promise<void> {
  const before = process.env[name];
  process.env[name] = value;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

describe('settings from the environment', () => {
  it('maps each variable to its setting', () => {
    expect(settingsFromEnvironment({
      MN_PASSPHRASE: 'p', MN_SEED: 's', MN_NO_LOCAL_DETECT: '1', MN_DUST_SYNC_BIN: '/bin/dust-sync',
      MN_DISABLE_NATIVE_DUST: '1', MN_DISABLE_DUST_COLLAPSE: '1', MN_BLOCKFROST_PROJECT_ID: 'nightpreprodAbc123', BLOCKFROST_PROJECT_ID: 'previewXyz',
    })).toEqual({
      passphrase: 'p', seed: 's', isLocalDetectOff: true, dustSyncBin: '/bin/dust-sync',
      isNativeDustOff: true, isDustCollapseOff: true, blockfrostProjectId: 'nightpreprodAbc123', sharedBlockfrostProjectId: 'previewXyz',
    });
  });

  it('turns a switch on only for 1', () => {
    expect(settingsFromEnvironment({ MN_NO_LOCAL_DETECT: 'yes', MN_DISABLE_NATIVE_DUST: '0' })).toMatchObject({ isLocalDetectOff: false, isNativeDustOff: false });
  });

  it('are read from a host\'s source each time, so a variable changed during the run is seen', () => {
    const env: Record<string, string | undefined> = { MN_SEED: 'first' };
    const host = createHost({ settings: () => settingsFromEnvironment(env) });
    expect(host.settings().seed).toBe('first');
    env.MN_SEED = 'second';
    expect(host.settings().seed).toBe('second');
  });
});

describe('a library takes its settings from its host or its caller, never the environment', () => {
  it('takes no passphrase from the environment when none is given', async () => {
    await withProcessEnv('MN_PASSPHRASE', 'set in the environment', async () => {
      await expect(readPassphrase(null)).rejects.toThrow(NoPassphraseError);
    });
  });

  it('takes the passphrase from its host\'s settings, not the environment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mn-settings-'));
    try {
      await withProcessEnv('MN_PASSPHRASE', 'set in the environment', async () => {
        const root = join(home, '.midnight');
        await expect(passphraseForNewSecret(createHost(), root)).rejects.toThrow(NoPassphraseError);
        const host = createHost({ settings: settingsFromEnvironment({ MN_PASSPHRASE: 'the host gives this one' }) });
        expect(await passphraseForNewSecret(host, root)).toBe('the host gives this one');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('takes MN_SEED from its host\'s settings, not the environment', async () => {
    const seed = '11'.repeat(32);
    await withProcessEnv('MN_SEED', '22'.repeat(32), async () => {
      const host = createHost({ settings: settingsFromEnvironment({ MN_SEED: seed }) });
      const resolved = await resolveSeedSource(parseArgs(['address']), '/nonexistent-state-root', host);
      expect(resolved.seed.toString('hex')).toBe(seed);
    });
  });

  it('takes the Blockfrost id it is given, not the environment\'s', async () => {
    await withProcessEnv('MN_BLOCKFROST_PROJECT_ID', 'nightpreprodFromTheEnvironment', () => {
      expect(resolveBlockfrostProjectId('preprod', '/nonexistent-config-dir', settingsFromEnvironment({ MN_BLOCKFROST_PROJECT_ID: 'nightpreprodAbc123' }))).toBe('nightpreprodAbc123');
      expect(resolveBlockfrostProjectId('preprod', '/nonexistent-config-dir', settingsFromEnvironment({}))).toBeUndefined();
    });
  });

  it('looks for a local stack unless the settings it is given say not to', () => {
    expect(detectLocalStacks(settingsFromEnvironment({ MN_NO_LOCAL_DETECT: '1' }))).toEqual({ node: [], indexer: [], proofServer: [] });
  });
});
