// The environment variables of spec §5.4 reach libraries only as settings
// the shell gives them: each maps to its setting, and a library with no
// settings source behaves as if none were set, whatever the environment says.

import { afterEach, describe, expect, it } from 'vitest';
import { setSettingsSource, settings, settingsFromEnvironment } from '../lib/settings.ts';
import { resolveBlockfrostProjectId } from '../lib/resolve-network.ts';
import { detectLocalStacks } from '../lib/network.ts';
import { readPassphrase, NoPassphraseError } from '../lib/passphrase.ts';

afterEach(() => {
  // Back to what the test harness gives, as the shell does.
  setSettingsSource(() => settingsFromEnvironment(process.env));
});

describe('settings from the environment', () => {
  it('maps each variable to its setting', () => {
    expect(settingsFromEnvironment({
      MN_PASSPHRASE: 'p', MN_SEED: 's', MN_NO_LOCAL_DETECT: '1', MN_DUST_SYNC_BIN: '/bin/dust-sync',
      MN_DISABLE_NATIVE_DUST: '1', MN_DISABLE_DUST_COLLAPSE: '1', MN_BLOCKFROST_PROJECT_ID: 'nightpreprodAbc123', BLOCKFROST_PROJECT_ID: 'previewXyz',
    })).toEqual({
      passphrase: 'p', seed: 's', noLocalDetect: true, dustSyncBin: '/bin/dust-sync',
      nativeDustDisabled: true, dustCollapseDisabled: true, blockfrostProjectId: 'nightpreprodAbc123', sharedBlockfrostProjectId: 'previewXyz',
    });
  });

  it('turns a switch on only for 1', () => {
    expect(settingsFromEnvironment({ MN_NO_LOCAL_DETECT: 'yes', MN_DISABLE_NATIVE_DUST: '0' })).toMatchObject({ noLocalDetect: false, nativeDustDisabled: false });
  });

  it('reads the source each time, so a variable changed during the run is seen', () => {
    const env: Record<string, string | undefined> = { MN_SEED: 'first' };
    setSettingsSource(() => settingsFromEnvironment(env));
    expect(settings().seed).toBe('first');
    env.MN_SEED = 'second';
    expect(settings().seed).toBe('second');
  });
});

describe('a library with no settings source', () => {
  it('takes no passphrase from the environment', async () => {
    process.env.MN_PASSPHRASE = 'set in the environment';
    try {
      setSettingsSource(null);
      await expect(readPassphrase({ prompter: null })).rejects.toThrow(NoPassphraseError);
    } finally {
      delete process.env.MN_PASSPHRASE;
    }
  });

  it('takes no Blockfrost id from the environment', () => {
    setSettingsSource(() => settingsFromEnvironment({ MN_BLOCKFROST_PROJECT_ID: 'nightpreprodAbc123' }));
    expect(resolveBlockfrostProjectId('preprod', '/nonexistent-config-dir')).toBe('nightpreprodAbc123');
    setSettingsSource(null);
    expect(resolveBlockfrostProjectId('preprod', '/nonexistent-config-dir')).toBeUndefined();
  });

  it('looks for a local stack unless the settings say not to', () => {
    setSettingsSource(() => settingsFromEnvironment({ MN_NO_LOCAL_DETECT: '1' }));
    expect(detectLocalStacks()).toEqual({ node: [], indexer: [], proofServer: [] });
  });
});
