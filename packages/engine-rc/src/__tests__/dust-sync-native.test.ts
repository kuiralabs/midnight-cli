import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ledger from '@midnightntwrk/ledger-v9';
import { pathToFileURL } from 'node:url';
import {
  resumeDecision, adaptResult, resolveSidecarBinary, nativeDustSyncAvailable, runDustSyncNative, platformPackageBinary,
  sidecarLedger, sidecarServesSync, readCheckpointCursor, SidecarLedgerMismatchError, type SidecarCheckpoint,
} from '../dust-sync-native.ts';
import { emptyDustLedgerState } from '../dust-ledger-state.ts';
import { DUST_STATE_OWNED_HEX } from './fixtures/dust-state-owned.ts';
import { settingsFromEnvironment } from '@kuiralabs/midnight-cli-core';

// The settings a host reading the environment gives its engine: what each test sets there.
const envSettings = () => settingsFromEnvironment(process.env);

describe('resumeDecision (kill-safe resume)', () => {
  it('resumes from an existing checkpoint that already reaches the cursor', () => {
    // A prior run was killed at event 500000; the repo wants to resume at 300000.
    expect(resumeDecision(500_000, 300_000, true)).toBe('existing');
    expect(resumeDecision(500_000, 300_000, false)).toBe('existing');
  });

  it('resumes from an existing checkpoint exactly at the boundary', () => {
    // cursor 41 means "applied through 41"; startFromId 42 is the next event.
    expect(resumeDecision(41, 42, false)).toBe('existing');
  });

  it('seeds from repo state when no usable checkpoint but cache exists', () => {
    expect(resumeDecision(-2, 0, true)).toBe('seed'); // no file, fresh cursor, has cache
    expect(resumeDecision(100, 500, true)).toBe('seed'); // stale file behind cursor
  });

  it('starts fresh when there is nothing to resume from', () => {
    expect(resumeDecision(-2, 0, false)).toBe('fresh');
    expect(resumeDecision(50, 500, false)).toBe('fresh'); // stale file, no cache
  });
});

describe('adaptResult (sidecar checkpoint → DustDirectResult)', () => {
  const cpFor = (dustStateHex: string, over: Partial<SidecarCheckpoint> = {}): SidecarCheckpoint => ({
    ledger: 9,
    dust_state: dustStateHex,
    last_applied_event_id: 42,
    owned_generation_indices: [3, 7],
    generation_frontier: 100,
    balance: '0',
    available_coins: 0,
    events_applied: 12345,
    partial: false,
    ...over,
  });

  it('maps a real funded dust state to the correct balance, coins, and retention', () => {
    // Real ledger-9 fixture: one dust UTXO still generating, so its balance
    // depends on time; read it at the state's own sync time.
    vi.useFakeTimers({ now: new Date('2026-10-05T06:14:30.000Z') });
    let r: ReturnType<typeof adaptResult>;
    try { r = adaptResult(cpFor(DUST_STATE_OWNED_HEX), envSettings()); } finally { vi.useRealTimers(); }
    expect(r.balance).toBe(1_436_566_695_496_744n);
    expect(r.availableCoins).toBe(1);
    expect(r.ownedUtxoCount).toBe(1);
    // Metadata passes through unchanged.
    expect(r.lastAppliedEventId).toBe(42);
    expect(r.eventCount).toBe(12345);
    expect(r.partial).toBe(false);
    expect(r.retention.ownedGenerationIndices).toEqual([3, 7]);
    expect(r.retention.generationFrontier).toBe(100);
    // State is a usable ledger object carrying the same UTXO the balance came from.
    expect(r.state.ledgerVersion).toBe(9);
    expect(r.state.state).toBeInstanceOf(ledger.DustLocalState);
    expect(r.state.state.utxos.length).toBe(r.ownedUtxoCount);
  });

  it('maps an empty state to a zero balance', () => {
    const empty = new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 10_800n));
    const hex = Buffer.from(empty.serialize()).toString('hex');
    const r = adaptResult(cpFor(hex, { partial: true, last_applied_event_id: -1 }), envSettings());
    expect(r.balance).toBe(0n);
    expect(r.availableCoins).toBe(0);
    expect(r.partial).toBe(true);
    expect(r.lastAppliedEventId).toBe(-1);
  });

  it('keeps no position from a run that stopped before the fork, while counting what it read', () => {
    const empty = new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 10_800n));
    const hex = Buffer.from(empty.serialize()).toString('hex');
    const r = adaptResult(cpFor(hex, { before_fork: true, partial: true, last_applied_event_id: 900_000, events_applied: 900_001 }), envSettings());
    expect(r.lastAppliedEventId).toBe(-1);
    expect(r.eventCount).toBe(900_001);
    expect(r.partial).toBe(true);
    expect(r.state.ledgerVersion).toBe(9);
  });

  it('refuses a finished run that says it stopped before the fork', () => {
    expect(() => adaptResult(cpFor(DUST_STATE_OWNED_HEX, { before_fork: true, partial: false }), envSettings())).toThrow('before the fork');
  });

  it('refuses a checkpoint of another ledger, so the caller falls back instead of reading it as ledger 9', () => {
    // A sidecar built before ledger 9 wrote no ledger field.
    const { ledger: _absent, ...legacy } = cpFor(DUST_STATE_OWNED_HEX);
    expect(() => adaptResult(legacy, envSettings())).toThrow(SidecarLedgerMismatchError);
    expect(() => adaptResult(cpFor(DUST_STATE_OWNED_HEX, { ledger: 8 }), envSettings())).toThrow('ledger-8 Dust state');
  });
});

describe('binary resolution + gating', () => {
  const saved = { ...process.env };
  afterEach(() => {
    // restore only the vars we touch
    for (const k of ['MN_DUST_SYNC_BIN', 'MN_DISABLE_NATIVE_DUST']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('honours the MN_DUST_SYNC_BIN override when the file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-dustbin-'));
    try {
      const bin = join(dir, 'dust-sync');
      writeFileSync(bin, '#!/bin/sh\n');
      process.env.MN_DUST_SYNC_BIN = bin;
      expect(resolveSidecarBinary(envSettings())).toBe(bin);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ignores a non-existent override path', () => {
    process.env.MN_DUST_SYNC_BIN = '/no/such/dust-sync-binary';
    // Falls through to the dev build or null — never returns the bad override.
    expect(resolveSidecarBinary(envSettings())).not.toBe('/no/such/dust-sync-binary');
  });

  // A sidecar that prints `ledger` for --ledger, or (null) one that refuses the flag as a ledger-8 build does.
  function sidecarAnswering(dir: string, ledger: number | null): string {
    const bin = join(dir, 'dust-sync');
    writeFileSync(bin, ledger === null
      ? '#!/bin/sh\necho "dust-sync: unknown flag: $1" >&2\nexit 2\n'
      : `#!/bin/sh\n[ "$1" = "--ledger" ] && echo ${ledger} && exit 0\nexit 2\n`, { mode: 0o755 });
    return bin;
  }

  it('selects a sidecar that folds ledger 9', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-dustbin-'));
    try {
      process.env.MN_DUST_SYNC_BIN = sidecarAnswering(dir, 9);
      delete process.env.MN_DISABLE_NATIVE_DUST;
      expect(sidecarLedger(process.env.MN_DUST_SYNC_BIN)).toBe(9);
      expect(nativeDustSyncAvailable(envSettings())).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never selects a sidecar of another ledger, or one that cannot say (a ledger-8 build), even when it resolves', () => {
    for (const ledger of [8, null]) {
      const dir = mkdtempSync(join(tmpdir(), 'mn-dustbin-'));
      try {
        const bin = sidecarAnswering(dir, ledger);
        process.env.MN_DUST_SYNC_BIN = bin;
        delete process.env.MN_DISABLE_NATIVE_DUST;
        expect(resolveSidecarBinary(envSettings())).toBe(bin);
        expect(sidecarLedger(bin)).toBe(ledger);
        expect(nativeDustSyncAvailable(envSettings())).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('disables native sync when MN_DISABLE_NATIVE_DUST=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-dustbin-'));
    try {
      const bin = join(dir, 'dust-sync');
      writeFileSync(bin, '#!/bin/sh\necho 9\n', { mode: 0o755 });
      process.env.MN_DUST_SYNC_BIN = bin;
      process.env.MN_DISABLE_NATIVE_DUST = '1';
      expect(nativeDustSyncAvailable(envSettings())).toBe(false); // gated off despite a resolvable binary
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('runDustSyncNative exit handling (fake sidecar binary)', () => {
  // The sidecar is an external process: a shell script stands in for it,
  // writing a valid checkpoint to --out and exiting with a chosen code.
  const saved = { ...process.env };
  let dir: string;
  afterEach(() => {
    for (const k of ['MN_DUST_SYNC_BIN', 'HOME']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeSidecar(exitCode: number): void {
    dir = mkdtempSync(join(tmpdir(), 'mn-fake-sidecar-'));
    const cp = JSON.stringify({
      ledger: 9, dust_state: DUST_STATE_OWNED_HEX, last_applied_event_id: 7, owned_generation_indices: [],
      generation_frontier: 0, balance: '0', available_coins: 0, events_applied: 7, partial: false,
    });
    const bin = join(dir, 'dust-sync');
    writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$@" > '${join(dir, 'args')}'`,
      'cat > /dev/null',
      'while [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then OUT="$2"; fi; shift; done',
      `printf '%s' '${cp}' > "$OUT"`,
      `exit ${exitCode}`,
    ].join('\n'), { mode: 0o755 });
    process.env.MN_DUST_SYNC_BIN = bin;
    process.env.HOME = dir;
  }

  const network = { indexer: 'http://x', indexerWS: 'ws://x', node: 'ws://x', proofServer: 'http://x', networkId: 'Undeployed' };
  const seed = Buffer.alloc(32, 7);

  it('accepts the checkpoint from a clean exit (control: the fake binary works)', async () => {
    fakeSidecar(0);
    const r = await runDustSyncNative(seed, network, { root: join(dir, '.midnight'), startFromId: 0, settings: envSettings() });
    expect(r.lastAppliedEventId).toBe(7);
  });

  it("tells the sidecar where ledger 9 starts, from the engine's fork schedule", async () => {
    fakeSidecar(0);
    await runDustSyncNative(seed, network, { root: join(dir, '.midnight'), startFromId: 0, settings: envSettings() });
    expect(readFileSync(join(dir, 'args'), 'utf-8')).toMatch(/--ledger9-from 2000000(\s|$)/);
  });

  it('never hands the sidecar a ledger-8 checkpoint to resume', async () => {
    fakeSidecar(0);
    await expect(runDustSyncNative(seed, network, {
      root: join(dir, '.midnight'), startFromId: 1_001, initialState: emptyDustLedgerState(8), settings: envSettings(),
    })).rejects.toThrow(SidecarLedgerMismatchError);
  });

  it('rejects a failed run even though a checkpoint file exists, so the caller falls back', async () => {
    // A ledger-8 sidecar on a ledger-9 chain dies like this (exit 2) after a
    // checkpoint already sits at --out; parsing it as success froze dust.
    fakeSidecar(2);
    await expect(runDustSyncNative(seed, network, { root: join(dir, '.midnight'), startFromId: 0, settings: envSettings() })).rejects.toThrow('dust-sync exited 2');
  });
});

describe('adaptResult — native-path generation-tree collapse', () => {
  // The Rust sidecar returns an UNcollapsed state; adaptResult applies the same TS
  // collapse the WASM reader uses so the fast/default path is also lean-restart.
  // The size win (~1.46 MB → ~23 KB) only shows at ~1.4M generations on real synced
  // state, so it's verified live, not here (and collapseForeignGenerations itself is
  // covered by dust-collapse.test.ts). This locks the invariants on the new branch:
  // both collapse-on and collapse-off run without error and preserve balance, owned
  // retention, and the generation-tree root.
  function stateWithForeignLeaves(n: number, ownedIdx: number): ledger.DustLocalState {
    const owner = ledger.sampleDustSecretKey().publicKey;
    const intent = ledger.sampleIntentHash();
    let s = new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 10_800n));
    for (let i = 0; i < n; i++) {
      s = s.insertGenerationInfo(BigInt(i), {
        value: 1_000_000n + BigInt(i),
        owner,
        nonce: ledger.dustInitialNonce(BigInt(i), intent),
        dtime: undefined,
      } as unknown as ledger.DustGenerationInfo);
    }
    return s;
  }

  const cpFor = (dustStateHex: string, over: Partial<SidecarCheckpoint> = {}): SidecarCheckpoint => ({
    ledger: 9, dust_state: dustStateHex, last_applied_event_id: 100, owned_generation_indices: [3],
    generation_frontier: 8, balance: '0', available_coins: 0, events_applied: 8, partial: false, ...over,
  });

  it('collapse-on and collapse-off preserve balance, retention, and the tree root', () => {
    // owned index 3; foreign ranges [0,2] and [4,7] → collapseForeignGenerations runs.
    const hex = Buffer.from(stateWithForeignLeaves(8, 3).serialize()).toString('hex');
    const cp = cpFor(hex, { owned_generation_indices: [3], generation_frontier: 8 });

    const on = adaptResult(cp, { isDustCollapseOff: false });
    const off = adaptResult(cp, { isDustCollapseOff: true });

    expect(on.balance).toBe(off.balance);                                   // collapse never moves the balance
    expect(on.retention.ownedGenerationIndices).toEqual([3]);              // owned indices pass through
    expect(on.state.state.generatingTreeRoot()).toBe(off.state.state.generatingTreeRoot()); // root invariant held
  });
});

describe("the sidecar's platform package", () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is found from a folder it is installed under, and is null where it is not', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mn-sidecar-package-')));
    const exe = process.platform === 'win32' ? 'dust-sync.exe' : 'dust-sync';
    const pkg = join(dir, 'node_modules', '@kuiralabs', `dust-sync-${process.platform}-${process.arch}`);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: `@kuiralabs/dust-sync-${process.platform}-${process.arch}`, version: '0.0.0' }));
    writeFileSync(join(pkg, exe), '');
    const from = pathToFileURL(join(dir, 'app', 'index.js')).href;

    expect(platformPackageBinary(from)).toBe(join(pkg, exe));
    expect(platformPackageBinary(pathToFileURL(join(tmpdir(), 'nowhere', 'index.js')).href)).toBeNull();
  });
});

describe('which syncs the sidecar serves', () => {
  it('serves a sync whose chain tip is on ledger 9, cold or resuming a ledger-9 checkpoint', () => {
    expect(sidecarServesSync({ chainProtocolVersion: 2_001_100n })).toBe(true);
    expect(sidecarServesSync({ chainProtocolVersion: 2_000_000n, initialState: emptyDustLedgerState(9) })).toBe(true);
  });

  it("leaves a sync resuming a ledger-8 checkpoint to mn's reader, which crosses the fork from it", () => {
    expect(sidecarServesSync({ chainProtocolVersion: 2_001_100n, initialState: emptyDustLedgerState(8) })).toBe(false);
  });

  it('leaves a sync on a chain whose tip is unknown or on ledger 8 to mn\'s reader', () => {
    // The sidecar's result is always ledger 9; only a chain past the fork ends there.
    expect(sidecarServesSync({ chainProtocolVersion: null })).toBe(false);
    expect(sidecarServesSync({ chainProtocolVersion: 1_000_000n })).toBe(false);
  });
});

describe("the sidecar's own checkpoint file", () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const write = (cp: object): string => {
    dir = mkdtempSync(join(tmpdir(), 'mn-native-cp-'));
    const path = join(dir, 'cp.json');
    writeFileSync(path, JSON.stringify(cp));
    return path;
  };

  it('resumes from a ledger-9 checkpoint at its cursor', () => {
    expect(readCheckpointCursor(write({ ledger: 9, last_applied_event_id: 41 }))).toBe(41);
  });

  it('ignores a checkpoint an earlier ledger-8 sidecar wrote, so it is never resumed', () => {
    expect(readCheckpointCursor(write({ last_applied_event_id: 1_500_000 }))).toBe(-2);
    expect(readCheckpointCursor(write({ ledger: 8, last_applied_event_id: 1_500_000 }))).toBe(-2);
  });
});
