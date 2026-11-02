// Spike EB: the probe both engines run. spike/pack.mjs copies this file into each engine before
// `npm pack`, so every bare import below resolves from the engine's own folder in the install.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const hex = (s) => Buffer.from(s, 'hex');
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

function packageOf(fileUrl) {
  let dir = path.dirname(fileURLToPath(fileUrl));
  while (dir !== path.dirname(dir)) {
    try {
      const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pj.name && pj.version) return { name: pj.name, version: pj.version, dir };
    } catch { /* keep walking */ }
    dir = path.dirname(dir);
  }
  return null;
}

/** Tag of a serialized ledger value: the ASCII prefix up to the first '['...']'. */
function tagOf(bytes) {
  const s = Buffer.from(bytes.subarray(0, 80)).toString('latin1');
  const m = s.match(/^midnight:([a-z0-9-]+\[v\d+\])/);
  return m ? m[1] : null;
}

const TX_MARKERS = [
  ['signature', 'proof', 'binding'],
  ['signature', 'proof', 'pre-binding'],
  ['signature', 'pre-proof', 'pre-binding'],
];

export function makeProbe({ set, facadeSpecifier, contractsSpecifier, dustLedger9Specifier }) {
  return async function probe(input = {}) {
    const ledger = await import('@midnightntwrk/ledger-v9');
    const runtime = await import('@midnight-ntwrk/compact-runtime');
    const facade = await import(facadeSpecifier);
    const contracts = await import(contractsSpecifier);

    const direct = {};
    for (const spec of ['@midnightntwrk/ledger-v9', '@midnightntwrk/onchain-runtime-v4', '@midnight-ntwrk/compact-runtime', facadeSpecifier, contractsSpecifier]) {
      try { const p = packageOf(import.meta.resolve(spec)); direct[spec] = p && `${p.version} @ ${p.dir}`; } catch (e) { direct[spec] = `unresolvable: ${e.message}`; }
    }

    const out = { set, direct, loadedFrom: { ledger: typeof ledger.LedgerParameters, runtime: typeof runtime.ContractState ?? typeof runtime, facade: typeof facade.WalletFacade, contracts: typeof contracts.deployContract } };

    // Hand a ledger object made by the engine's own ledger to the wallet SDK's Dust wallet, which
    // builds a DustLocalState from it with ITS ledger. Two physical ledger copies fail here.
    try {
      const dustMod = await import(dustLedger9Specifier);
      const params = ledger.LedgerParameters.initialParameters().dust;
      const sk = ledger.DustSecretKey.fromSeed(new Uint8Array(32).fill(9));
      const core = dustMod.CoreWallet.initEmpty(params, sk, 'undeployed');
      out.sdkTakesEngineLedgerObjects = { ok: true, stateBytes: core.state.serialize().length };
    } catch (e) { out.sdkTakesEngineLedgerObjects = { ok: false, error: String(e.message ?? e).slice(0, 200) }; }

    out.params = {};
    for (const [label, h] of Object.entries(input.params ?? {})) {
      const bytes = hex(h);
      try {
        const p = ledger.LedgerParameters.deserialize(bytes);
        out.params[label] = { tag: tagOf(bytes), ok: true, roundTrip: eq(p.serialize(), bytes), feeOverall: String(p.feePrices?.overallPrice ?? '?') };
      } catch (e) { out.params[label] = { tag: tagOf(bytes), ok: false, error: String(e.message ?? e).slice(0, 200) }; }
    }

    out.txs = {};
    for (const [label, list] of Object.entries(input.txs ?? {})) {
      out.txs[label] = list.map((t) => {
        const bytes = hex(t.raw);
        const errors = [];
        for (const m of TX_MARKERS) {
          try {
            const tx = ledger.Transaction.deserialize(...m, bytes);
            return { height: t.height, tag: tagOf(bytes), ok: true, markers: m.join('/'), roundTrip: eq(tx.serialize(), bytes), hashMatches: tx.transactionHash() === t.hash };
          } catch (e) { errors.push(String(e.message ?? e).slice(0, 120)); }
        }
        return { height: t.height, tag: tagOf(bytes), ok: false, errors };
      });
    }

    if (input.dustEvents) {
      // Replay the first `split` events into a fresh DustLocalState, hand the bytes over, then the rest.
      const sk = ledger.DustSecretKey.fromSeed(new Uint8Array(32).fill(7));
      const events = input.dustEvents.map((e) => ledger.Event.deserialize(hex(e.raw)));
      const split = input.dustSplit ?? Math.floor(events.length / 2);
      const fresh = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
      const freshBytes = fresh.serialize();
      const half = fresh.replayEvents(sk, events.slice(0, split));
      const halfBytes = half.serialize();
      const full = half.replayEvents(sk, events.slice(split));
      const fullBytes = full.serialize();
      const selfRead = (bytes) => { try { return eq(ledger.DustLocalState.deserialize(bytes).serialize(), bytes); } catch (e) { return `fails: ${String(e.message ?? e).slice(0, 120)}`; } };
      out.dust = { events: events.length, split, freshTag: tagOf(freshBytes), fresh: sha(freshBytes), half: sha(halfBytes), full: sha(fullBytes), selfReadFresh: selfRead(freshBytes), selfReadHalf: selfRead(halfBytes), selfReadFull: selfRead(fullBytes), halfHex: Buffer.from(halfBytes).toString('hex'), freshHex: Buffer.from(freshBytes).toString('hex') };
      if (input.foreignDust) {
        const r = {};
        for (const [which, h] of Object.entries(input.foreignDust)) {
          try {
            const s = ledger.DustLocalState.deserialize(hex(h));
            r[which] = { ok: true, roundTrip: eq(s.serialize(), hex(h)) };
            // replayEvents consumes the Event objects, so the continuation needs fresh ones.
            const rest = input.dustEvents.slice(split).map((e) => ledger.Event.deserialize(hex(e.raw)));
            if (which === 'half') r[which].continuedFullMatchesOwn = sha(s.replayEvents(sk, rest).serialize()) === out.dust.full;
          } catch (e) { r[which] = { ok: false, error: String(e.message ?? e).slice(0, 200) }; }
        }
        out.foreignDust = r;
      }
    }
    return out;
  };
}
