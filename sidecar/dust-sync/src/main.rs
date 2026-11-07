// Native dust-sync sidecar.
//
// Streams `dustLedgerEvents` from the indexer, replays them natively into a
// ledger-9 `DustLocalState` (several times faster than WASM), and writes a
// checkpoint the CLI reads straight into its dust cache. Read-only w.r.t. the
// chain; the dust secret key is read from stdin and zeroized. Output
// (checkpoint file + final stdout line) mirrors the CLI's `DustDirectResult`.
//
// A chain that forked from ledger 8 serves its pre-fork Dust events in
// ledger-8 format. mn's reader folds them with ledger 8 and, at the first
// ledger-9 event, continues from the cross-ledger migration's state, which is
// an empty ledger-9 state: nothing of the ledger-8 fold survives the fork. So
// this sidecar reads those events and folds none of them, starting its
// ledger-9 fold at the fork, and its result is the same ledger-9 state.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use midnight_base_crypto::time::Timestamp;
use midnight_ledger::dust::{DustLocalState, DustPublicKey, DustSecretKey};
use midnight_ledger::events::{Event, EventDetails};
use midnight_ledger::structure::LedgerParameters;
use midnight_serialize::{tagged_deserialize, tagged_serialize};
use midnight_storage::db::InMemoryDB;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::{HeaderValue, SEC_WEBSOCKET_PROTOCOL};
use tungstenite::Message;
use zeroize::Zeroize;

type Db = InMemoryDB;

const CHUNK: usize = 500;
const CHECKPOINT_EVERY: u64 = 20_000;

/// The ledger this build folds Dust events with: the only ledger of the states
/// it reads and writes. `--ledger` prints it, so the CLI can refuse a binary
/// built for another ledger before running it.
const LEDGER: u32 = 9;

struct Args {
    indexer_ws: String,
    out: String,
    resume: Option<String>,
    timeout_secs: u64,
    idle_secs: u64,
    initial_silence_secs: u64,
    /// The protocol version ledger 9 starts at (the CLI's fork schedule).
    ledger9_from: i64,
}

fn parse_args() -> Args {
    let mut a = Args { indexer_ws: String::new(), out: String::new(), resume: None, timeout_secs: 600, idle_secs: 5, initial_silence_secs: 3, ledger9_from: -1 };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--ledger" => { println!("{LEDGER}"); std::process::exit(0); }
            "--ledger9-from" => a.ledger9_from = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| die("--ledger9-from needs a protocol version")),
            "--indexer-ws" => a.indexer_ws = it.next().expect("--indexer-ws value"),
            "--out" => a.out = it.next().expect("--out value"),
            "--resume" => a.resume = it.next(),
            "--timeout-secs" => a.timeout_secs = it.next().and_then(|v| v.parse().ok()).unwrap_or(600),
            "--idle-secs" => a.idle_secs = it.next().and_then(|v| v.parse().ok()).unwrap_or(5),
            "--initial-silence-secs" => a.initial_silence_secs = it.next().and_then(|v| v.parse().ok()).unwrap_or(3),
            other => die(&format!("unknown flag: {other}")),
        }
    }
    if a.indexer_ws.is_empty() || a.out.is_empty() || a.ledger9_from < 0 {
        die("required: --indexer-ws <url> --out <file> --ledger9-from <protocol version>");
    }
    a
}

/// Make rustls use ring. base-crypto links rustls with aws-lc-rs (through
/// reqwest) and ureq/tungstenite link it with ring, so rustls can't choose a
/// provider on its own and panics on the first TLS connection (every `wss://`
/// indexer). Must run before any connection.
fn install_crypto_provider() {
    // Err only when a provider is installed already, which is what we want.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Where the fold stands relative to the ledger-8 to ledger-9 fork, as mn's
/// reader tracks it with the ledger of its state.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// No event read and nothing resumed.
    Start,
    /// Reading a forked chain's ledger-8 events, folding none of them.
    BeforeFork,
    /// Folding ledger-9 events (a resumed checkpoint is always here).
    Ledger9,
}

/// What to do with one event.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    /// A ledger-8 event before the fork: read, not folded.
    Pass,
    /// A ledger-9 event: fold it (the first one starts the ledger-9 fold).
    Fold,
}

/// The action for an event under `protocol_version` (None when the indexer
/// doesn't say) and the phase after it. Decides each event's ledger as mn's
/// reader does: ledger 8 below `ledger9_from`, ledger 9 from it, and an event
/// with no version on the ledger of the fold so far (ledger 9 at the start).
/// A ledger-8 event after the fold reached ledger 9 is an error: the indexer
/// served the events out of order across the fork.
fn next_phase(phase: Phase, protocol_version: Option<i64>, ledger9_from: i64) -> Result<(Action, Phase), String> {
    let ledger8 = match protocol_version {
        Some(v) => v < ledger9_from,
        None => phase == Phase::BeforeFork,
    };
    match (ledger8, phase) {
        (true, Phase::Ledger9) => Err(format!(
            "a ledger-8 event (protocol version {}) after the Dust state reached ledger 9: the indexer served the events out of order across the fork",
            protocol_version.map(|v| v.to_string()).unwrap_or_else(|| "unknown".into()),
        )),
        (true, _) => Ok((Action::Pass, Phase::BeforeFork)),
        (false, _) => Ok((Action::Fold, Phase::Ledger9)),
    }
}

/// What a run reports when it ends, by where it stopped.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Outcome {
    /// The state and cursor it reached: a ledger-9 fold, or a read of a whole
    /// timeline with no ledger-9 event yet (the CLI runs this sidecar only on a
    /// chain past the fork, so that timeline ends on an empty ledger-9 state).
    Reached,
    /// Stopped inside a forked chain's ledger-8 events. No ledger-9 state
    /// exists at that cursor, so the checkpoint is marked `before_fork`: this
    /// sidecar resumes reading from it, and the CLI keeps no Dust state from it.
    BeforeFork,
    /// Stopped before any event: nothing to keep.
    NothingRead,
}

fn outcome(phase: Phase, partial: bool) -> Outcome {
    match (phase, partial) {
        (Phase::Ledger9, _) | (_, false) => Outcome::Reached,
        (Phase::BeforeFork, true) => Outcome::BeforeFork,
        (Phase::Start, true) => Outcome::NothingRead,
    }
}

/// The phase a run starts in: a fresh run at the start; a resumed one where its
/// checkpoint stopped (before the fork, or folding ledger 9).
fn resumed_phase(before_fork: Option<bool>) -> Phase {
    match before_fork {
        None => Phase::Start,
        Some(true) => Phase::BeforeFork,
        Some(false) => Phase::Ledger9,
    }
}

fn die(msg: &str) -> ! {
    eprintln!("dust-sync: {}", redact_project_id(msg));
    std::process::exit(2);
}

/// The text with the value of any `project_id=` query parameter hidden. The
/// indexer URL can carry a Blockfrost project id, and errors quote the URL.
fn redact_project_id(text: &str) -> String {
    const KEY: &str = "project_id=";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(KEY) {
        let value_at = at + KEY.len();
        out.push_str(&rest[..value_at]);
        out.push_str("***");
        let value = &rest[value_at..];
        let end = value
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '~' | '%' | '-')))
            .unwrap_or(value.len());
        rest = &value[end..];
    }
    out.push_str(rest);
    out
}

/// The indexer's HTTP URL for its WebSocket URL: the scheme changed and the
/// path's trailing `/ws` dropped. A query string stays where it is.
fn http_from_ws(ws: &str) -> String {
    let (base, query) = match ws.find('?') {
        Some(at) => (&ws[..at], &ws[at..]),
        None => (ws, ""),
    };
    let mut s = base.to_string();
    if let Some(rest) = s.strip_prefix("wss://") { s = format!("https://{rest}"); }
    else if let Some(rest) = s.strip_prefix("ws://") { s = format!("http://{rest}"); }
    let path = s.strip_suffix("/ws").map(|x| x.to_string()).unwrap_or(s);
    format!("{path}{query}")
}

/// Parse a hex string into a 32-byte seed. Pure (testable). Zeroizes its own
/// decoded intermediate — the caller can't reach this buffer, so it must wipe it.
fn parse_seed(hex_str: &str) -> Result<[u8; 32], String> {
    let mut bytes = hex::decode(hex_str.trim()).map_err(|e| format!("seed must be hex: {e}"))?;
    if bytes.len() != 32 {
        let n = bytes.len();
        bytes.zeroize();
        return Err(format!("seed must be 32 bytes (64 hex chars), got {n}"));
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&bytes);
    bytes.zeroize();
    Ok(seed)
}

/// Read one hex line (the raw 32-byte dust seed) from stdin, zeroizing buffers.
fn read_seed_stdin() -> [u8; 32] {
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap_or_else(|e| die(&format!("read seed from stdin: {e}")));
    let seed = parse_seed(&line).unwrap_or_else(|e| { line.zeroize(); die(&e) });
    line.zeroize();
    seed
}

/// Current on-chain ledger params (block-level, so ParamChange is honoured).
fn fetch_params(http: &str) -> LedgerParameters {
    let resp: serde_json::Value = ureq::post(http)
        .send_json(serde_json::json!({ "query": "{ block { ledgerParameters } }" }))
        .unwrap_or_else(|e| die(&format!("params query: {e}")))
        .into_json()
        .unwrap_or_else(|e| die(&format!("params json: {e}")));
    let hexp = resp["data"]["block"]["ledgerParameters"].as_str()
        .unwrap_or_else(|| die("block has no ledgerParameters"));
    let bytes = hex::decode(hexp).unwrap_or_else(|e| die(&format!("params hex: {e}")));
    tagged_deserialize(&bytes[..]).unwrap_or_else(|e| die(&format!("deserialize params: {e}")))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Checkpoint {
    /// The ledger of `dust_state`; 0 in a checkpoint written before the field existed.
    #[serde(default)]
    ledger: u32,
    dust_state: String, // tagged_serialize(DustLocalState) hex
    last_applied_event_id: i64,
    owned_generation_indices: Vec<u64>,
    generation_frontier: u64,
    balance: String, // u128 as string (JSON-safe)
    available_coins: usize,
    events_applied: u64,
    partial: bool,
    /// The cursor is inside a forked chain's ledger-8 events: `dust_state` is
    /// the fresh ledger-9 state the fold will start from at the fork, not a
    /// state at that cursor.
    #[serde(default)]
    before_fork: bool,
}

// `Complete` = the server cleanly ended the subscription; `Failed` = a connect,
// subscription, or mid-stream socket error. They must NOT be conflated: a failure
// while still behind the tip has to be reported `partial` so the CLI resumes,
// rather than caching an incomplete sync as done.
enum WsMsg { Event { id: i64, raw: String, max_id: i64, protocol_version: Option<i64> }, Complete, Failed }

/// A clean server `complete` only counts as done if we actually reached the tip
/// we were told about (`max_id`). If it ended while still behind — or we never
/// learned a tip but saw events — the sync must resume. (A `complete` with no
/// events at all, `max_id < 0`, means an empty dust history: genuinely done.)
fn complete_is_partial(last_id: i64, max_id: i64) -> bool {
    max_id >= 0 && last_id < max_id
}

/// Fast-return decision for a resume-at-tip run, mirroring the WASM reader's
/// `initialSilenceMs` behaviour (src/lib/dust-direct.ts): when we RESUMED from a
/// cached checkpoint and NO event has arrived within the initial-silence window,
/// there is nothing new to apply — we're caught up to the tip, so finish cleanly
/// (`partial = false`). A FRESH sync (no checkpoint) must NOT fast-return on
/// silence: a cold subscription can be slow to its first event, so it keeps
/// waiting. Only meaningful while `!saw_event` — once events arrive, the idle
/// timer governs (idle-after-events means still behind the tip → partial).
fn caught_up_on_initial_silence(is_resume: bool, saw_event: bool) -> bool {
    is_resume && !saw_event
}

/// Background WS reader: graphql-transport-ws handshake, forwards dust events.
fn spawn_reader(ws_url: String, start_id: i64, tx: mpsc::Sender<WsMsg>) {
    std::thread::spawn(move || {
        // The indexer requires the graphql-transport-ws subprotocol; without the
        // header it rejects the upgrade with 400 (the TS client sets it too).
        let req = match ws_url.as_str().into_client_request() {
            Ok(mut r) => { r.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static("graphql-transport-ws")); r }
            Err(e) => { eprintln!("dust-sync: ws request: {}", redact_project_id(&e.to_string())); let _ = tx.send(WsMsg::Failed); return; }
        };
        let (mut sock, _) = match tungstenite::connect(req) {
            Ok(x) => x,
            Err(e) => { eprintln!("dust-sync: ws connect: {}", redact_project_id(&e.to_string())); let _ = tx.send(WsMsg::Failed); return; }
        };
        let _ = sock.send(Message::Text(r#"{"type":"connection_init"}"#.into()));
        let sub = serde_json::json!({
            "id": "1", "type": "subscribe",
            "payload": { "query": "subscription($id:Int){dustLedgerEvents(id:$id){id raw maxId protocolVersion}}", "variables": { "id": start_id } }
        }).to_string();
        loop {
            match sock.read() {
                Ok(Message::Text(t)) => {
                    let m: serde_json::Value = match serde_json::from_str(&t) { Ok(v) => v, Err(_) => continue };
                    match m["type"].as_str() {
                        Some("connection_ack") => { let _ = sock.send(Message::Text(sub.clone().into())); }
                        Some("next") => {
                            let e = &m["payload"]["data"]["dustLedgerEvents"];
                            if let (Some(id), Some(raw), Some(max_id)) = (e["id"].as_i64(), e["raw"].as_str(), e["maxId"].as_i64()) {
                                let protocol_version = e["protocolVersion"].as_i64();
                                if tx.send(WsMsg::Event { id, raw: raw.to_string(), max_id, protocol_version }).is_err() { break; }
                            }
                        }
                        Some("error") => { eprintln!("dust-sync: subscription error: {}", m["payload"]); let _ = tx.send(WsMsg::Failed); break; }
                        Some("complete") => { let _ = tx.send(WsMsg::Complete); break; }
                        _ => {}
                    }
                }
                Ok(Message::Ping(p)) => { let _ = sock.send(Message::Pong(p)); }
                Ok(Message::Close(_)) | Err(_) => { let _ = tx.send(WsMsg::Failed); break; }
                _ => {}
            }
        }
    });
}

fn now_ts() -> Timestamp {
    Timestamp::from_secs(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
}

fn checkpoint_of(state: &DustLocalState<Db>, last_id: i64, owned: &BTreeSet<u64>, frontier: u64, events_applied: u64, partial: bool, before_fork: bool) -> Checkpoint {
    let mut buf = Vec::new();
    tagged_serialize(state, &mut buf).unwrap_or_else(|e| die(&format!("serialize state: {e}")));
    Checkpoint {
        ledger: LEDGER,
        dust_state: hex::encode(&buf),
        last_applied_event_id: last_id,
        owned_generation_indices: owned.iter().copied().collect(),
        generation_frontier: frontier,
        balance: state.wallet_balance(now_ts()).to_string(),
        available_coins: state.utxos().count(),
        events_applied,
        partial,
        before_fork,
    }
}

fn write_checkpoint(out: &str, state: &DustLocalState<Db>, last_id: i64, owned: &BTreeSet<u64>, frontier: u64, events_applied: u64, partial: bool, before_fork: bool) -> Checkpoint {
    let cp = checkpoint_of(state, last_id, owned, frontier, events_applied, partial, before_fork);
    let json = serde_json::to_string(&cp).expect("serialize checkpoint");
    write_private_file(out, json.as_bytes()).unwrap_or_else(|e| die(&format!("write checkpoint {out}: {e}")));
    cp
}

/// Temp files this process has made, so two writes in one process never share a name.
static TEMP_FILES_MADE: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `path` atomically, readable by its owner only (0600, as the
/// CLI's other Dust caches: the state holds the wallet's coins). A temp file of
/// its own beside `path`, named for this process and this write, then a rename
/// over `path`: a reader sees the old file or the new one, never part of one,
/// and two runs writing the same checkpoint never write into each other's temp.
fn write_private_file(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    let n = TEMP_FILES_MADE.fetch_add(1, Ordering::Relaxed);
    let tmp = format!("{path}.{}.{n}.tmp", std::process::id());
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&tmp).and_then(|mut file| {
        use std::io::Write;
        file.write_all(bytes)?;
        file.sync_all()
    });
    let renamed = written.and_then(|()| std::fs::rename(&tmp, path));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    renamed
}

fn main() {
    install_crypto_provider();
    let args = parse_args();
    let http = http_from_ws(&args.indexer_ws);

    let mut seed = read_seed_stdin();
    let sk = DustSecretKey::derive_secret_key(&seed);
    let my_pk = DustPublicKey::from(sk.clone());
    seed.zeroize(); // raw seed no longer needed — don't leave it in memory

    let params = fetch_params(&http);

    // Resume from a prior checkpoint, or start fresh. `is_resume` records whether
    // we actually loaded cached state — it mirrors the WASM reader's `initialState`
    // presence and gates the initial-silence fast-return below (a failed parse
    // falls through to a fresh sync, which must NOT fast-return on silence).
    let resumed = args.resume.as_deref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str::<Checkpoint>(&s).ok());
    let is_resume = resumed.is_some();
    let mut phase = resumed_phase(resumed.as_ref().map(|cp| cp.before_fork));
    let (mut state, mut last_id, mut owned, mut frontier, mut events_applied): (DustLocalState<Db>, i64, BTreeSet<u64>, u64, u64) =
        match resumed {
            Some(cp) => {
                if cp.ledger != LEDGER { die(&format!("the resume checkpoint holds a ledger-{} Dust state; this sidecar reads ledger {LEDGER} only", cp.ledger)); }
                let bytes = hex::decode(&cp.dust_state).unwrap_or_else(|e| die(&format!("resume state hex: {e}")));
                let st = tagged_deserialize(&bytes[..]).unwrap_or_else(|e| die(&format!("resume deserialize: {e}")));
                // events_applied counts THIS run (matches the WASM path's per-call
                // semantics), so reset to 0 on resume rather than carrying it.
                (st, cp.last_applied_event_id, cp.owned_generation_indices.into_iter().collect(), cp.generation_frontier, 0)
            }
            None => (DustLocalState::new(params.dust), -1, BTreeSet::new(), 0, 0),
        };

    let interrupted = Arc::new(AtomicBool::new(false));
    { let f = interrupted.clone(); let _ = ctrlc::set_handler(move || f.store(true, Ordering::SeqCst)); }

    let start_id = last_id + 1;
    let (tx, rx) = mpsc::channel();
    spawn_reader(args.indexer_ws.clone(), start_id, tx);

    let mut batch: Vec<Event<Db>> = Vec::with_capacity(CHUNK);
    #[allow(unused_assignments)] // -1 is a "no events seen" sentinel; overwritten on the first event
    let mut max_id: i64 = -1;
    let mut saw_event = false;
    let mut next_mark: u64 = events_applied + CHECKPOINT_EVERY;
    let deadline = Instant::now() + Duration::from_secs(args.timeout_secs);
    let mut partial = false;

    let flush = |state: &mut DustLocalState<Db>, batch: &mut Vec<Event<Db>>| {
        if batch.is_empty() { return; }
        *state = state.replay_events(&sk, batch.iter()).unwrap_or_else(|e| die(&format!("replay: {e}")));
        batch.clear();
    };

    loop {
        if interrupted.load(Ordering::SeqCst) { partial = true; break; }
        if Instant::now() >= deadline { partial = true; break; }
        // While a resume run is still waiting for its first event, poll on the
        // shorter initial-silence window so a resume-at-tip (zero new events)
        // returns as fast as the WASM reader instead of idling for `idle_secs`.
        // Once events have arrived (or on a fresh sync) fall back to `idle_secs`.
        let recv_secs = if caught_up_on_initial_silence(is_resume, saw_event) { args.initial_silence_secs } else { args.idle_secs };
        match rx.recv_timeout(Duration::from_secs(recv_secs)) {
            Ok(WsMsg::Event { id, raw, max_id: mid, protocol_version }) => {
                saw_event = true;
                let (action, next) = next_phase(phase, protocol_version, args.ledger9_from)
                    .unwrap_or_else(|e| die(&format!("event {id}: {e}")));
                // Before the fork nothing is folded, so the first ledger-9 event
                // starts from the fresh state, owned set and frontier still held.
                phase = next;
                if action == Action::Fold {
                    let bytes = hex::decode(&raw).unwrap_or_else(|e| die(&format!("event hex: {e}")));
                    let ev: Event<Db> = tagged_deserialize(&bytes[..]).unwrap_or_else(|e| die(&format!("deserialize event {id}: {e}")));
                    if let EventDetails::DustInitialUtxo { generation, generation_index, .. } = &ev.content {
                        if *generation_index + 1 > frontier { frontier = *generation_index + 1; }
                        if generation.owner == my_pk { owned.insert(*generation_index); }
                    }
                    batch.push(ev);
                }
                events_applied += 1;
                last_id = id;
                max_id = mid;
                if batch.len() >= CHUNK { flush(&mut state, &mut batch); }
                // Progress and a checkpoint, periodically (not every chunk: the
                // growing state can be MBs, and a per-chunk write is GBs of disk
                // churn). Before the fork it records only how far the read got.
                if events_applied >= next_mark {
                    flush(&mut state, &mut batch);
                    write_checkpoint(&args.out, &state, last_id, &owned, frontier, events_applied, true, phase == Phase::BeforeFork);
                    eprintln!("dust-sync: applied {events_applied} / {max_id}");
                    next_mark += CHECKPOINT_EVERY;
                }
                if max_id >= 0 && last_id >= max_id { break; } // caught up to tip
            }
            // Timeout with no message. Three cases:
            //  - events already seen → behind the tip (a clean catch-up breaks via
            //    the tip check above), so mark partial and let the CLI resume.
            //  - resume run, still no event → the initial-silence window elapsed
            //    with nothing to apply: we're caught up to the tip. Finish cleanly
            //    (partial = false), mirroring the WASM reader's initialSilence path.
            //  - fresh sync, still no event → keep waiting; a cold subscription can
            //    be slow to its first event, and there's no cached tip to trust.
            Err(RecvTimeoutError::Timeout) => {
                if saw_event { partial = true; break; }
                if caught_up_on_initial_silence(is_resume, saw_event) { partial = false; break; }
            }
            // Server ended the subscription cleanly: done only if we reached the tip.
            Ok(WsMsg::Complete) => { partial = complete_is_partial(last_id, max_id); break; }
            // A connect/subscription/socket failure (or the reader thread dying) is
            // never a clean finish — mark partial so the CLI resumes next run rather
            // than caching an incomplete sync as complete.
            Ok(WsMsg::Failed) | Err(RecvTimeoutError::Disconnected) => { partial = true; break; }
        }
    }

    flush(&mut state, &mut batch);
    let cp = match outcome(phase, partial) {
        Outcome::Reached => write_checkpoint(&args.out, &state, last_id, &owned, frontier, events_applied, partial, false),
        Outcome::BeforeFork => write_checkpoint(&args.out, &state, last_id, &owned, frontier, events_applied, true, true),
        Outcome::NothingRead => checkpoint_of(&state, start_id - 1, &owned, frontier, 0, true, false),
    };
    // Final one-line status on stdout for the CLI to parse without re-reading the file.
    println!("{}", serde_json::to_string(&cp).expect("status json"));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A new empty directory under the system's temp directory.
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dust-sync-{name}-{}-{}", std::process::id(), TEMP_FILES_MADE.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn a_checkpoint_is_written_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        let out = dir.join("dust-native-key.json");
        // An earlier checkpoint left world-readable is replaced by a private one.
        std::fs::write(&out, "old").unwrap();
        std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_private_file(out.to_str().unwrap(), b"{\"ledger\":9}").unwrap();

        assert_eq!(std::fs::metadata(&out).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "{\"ledger\":9}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_checkpoint_write_leaves_no_temp_file_and_never_reuses_one() {
        let dir = temp_dir("tmp");
        let out = dir.join("dust-native-key.json");
        let out = out.to_str().unwrap();
        // A temp file another run is still writing, at the name the sidecar once always used.
        std::fs::write(format!("{out}.tmp"), "another run's").unwrap();

        write_private_file(out, b"first").unwrap();
        write_private_file(out, b"second").unwrap();

        assert_eq!(std::fs::read_to_string(out).unwrap(), "second");
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, vec!["dust-native-key.json".to_string(), "dust-native-key.json.tmp".to_string()]);
        assert_eq!(std::fs::read_to_string(format!("{out}.tmp")).unwrap(), "another run's");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn http_from_ws_derives_endpoint() {
        assert_eq!(http_from_ws("wss://host/api/v4/graphql/ws"), "https://host/api/v4/graphql");
        assert_eq!(http_from_ws("ws://localhost:8088/api/v1/graphql/ws"), "http://localhost:8088/api/v1/graphql");
        // No /ws suffix: protocol swap only.
        assert_eq!(http_from_ws("wss://host/graphql"), "https://host/graphql");
    }

    // A Blockfrost URL carries its project id as a query: the /ws before it was
    // kept, and the params query went to the WebSocket path (HTTP 405).
    #[test]
    fn http_from_ws_keeps_a_query_string() {
        assert_eq!(
            http_from_ws("wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=nightpreprodAbCd"),
            "https://midnight-preprod.blockfrost.io/api/v0?project_id=nightpreprodAbCd"
        );
        assert_eq!(http_from_ws("wss://host/graphql?ws=/ws"), "https://host/graphql?ws=/ws");
    }

    #[test]
    fn redact_project_id_hides_the_value_only() {
        assert_eq!(
            redact_project_id("params query: https://h/api/v0?project_id=nightpreprodAbCd0123: status code 405"),
            "params query: https://h/api/v0?project_id=***: status code 405"
        );
        assert_eq!(redact_project_id("a?x=1&project_id=secret&y=2 and b?project_id=other"), "a?x=1&project_id=***&y=2 and b?project_id=***");
        assert_eq!(redact_project_id("applied 5 / 10"), "applied 5 / 10");
    }

    #[test]
    fn parse_seed_accepts_valid_32_byte_hex() {
        let hex = "00".repeat(31) + "01";
        let seed = parse_seed(&format!("  {hex}\n")).expect("valid seed");
        assert_eq!(seed[31], 1);
        assert_eq!(seed[0], 0);
    }

    #[test]
    fn parse_seed_rejects_wrong_length_and_bad_hex() {
        assert!(parse_seed(&"ab".repeat(16)).is_err()); // 16 bytes, too short
        assert!(parse_seed(&"ab".repeat(33)).is_err()); // 33 bytes, too long
        assert!(parse_seed("zz".repeat(32).as_str()).is_err()); // not hex
    }

    #[test]
    fn checkpoint_json_round_trips() {
        let cp = Checkpoint {
            ledger: LEDGER,
            dust_state: "deadbeef".into(),
            last_applied_event_id: 4242,
            owned_generation_indices: vec![3, 7, 100],
            generation_frontier: 373362,
            balance: "136016950999999999".into(),
            available_coins: 1,
            events_applied: 1409471,
            partial: false,
            before_fork: false,
        };
        let json = serde_json::to_string(&cp).unwrap();
        let back: Checkpoint = serde_json::from_str(&json).unwrap();
        assert_eq!(back.ledger, 9);
        assert_eq!(back.last_applied_event_id, 4242);
        assert_eq!(back.owned_generation_indices, vec![3, 7, 100]);
        assert_eq!(back.generation_frontier, 373362);
        assert_eq!(back.balance, "136016950999999999"); // u128 kept as string (JSON-safe)
        assert_eq!(back.available_coins, 1);
        assert!(!back.partial);
    }

    #[test]
    fn complete_is_partial_only_when_behind_the_tip() {
        // Caught up to a known tip → complete (not partial).
        assert!(!complete_is_partial(100, 100));
        assert!(!complete_is_partial(101, 100));
        // Server ended while still behind the tip → must resume.
        assert!(complete_is_partial(50, 100));
        // No events / no known tip → empty dust history, genuinely done.
        assert!(!complete_is_partial(-1, -1));
    }

    #[test]
    fn initial_silence_fast_returns_only_for_resume_before_first_event() {
        // Resume run, no event yet → initial-silence elapsed means caught up to tip.
        assert!(caught_up_on_initial_silence(true, false));
        // Resume run but an event already arrived → idle timer governs, not this.
        assert!(!caught_up_on_initial_silence(true, true));
        // Fresh sync, no event yet → must keep waiting (cold first-event latency).
        assert!(!caught_up_on_initial_silence(false, false));
        // Fresh sync with events → never fast-returns via this path.
        assert!(!caught_up_on_initial_silence(false, true));
    }

    // A checkpoint from a sidecar built before the field existed (ledger 8)
    // reads as ledger 0, which a resume refuses.
    #[test]
    fn a_checkpoint_without_a_ledger_reads_as_ledger_0() {
        let json = r#"{"dust_state":"00","last_applied_event_id":1,"owned_generation_indices":[],"generation_frontier":0,"balance":"0","available_coins":0,"events_applied":1,"partial":false}"#;
        let cp: Checkpoint = serde_json::from_str(json).unwrap();
        assert_eq!(cp.ledger, 0);
    }

    const FORK: i64 = 2_000_000;

    #[test]
    fn ledger_8_events_before_the_fork_are_read_not_folded() {
        assert_eq!(next_phase(Phase::Start, Some(1_000_000), FORK), Ok((Action::Pass, Phase::BeforeFork)));
        assert_eq!(next_phase(Phase::BeforeFork, Some(1_999_999), FORK), Ok((Action::Pass, Phase::BeforeFork)));
    }

    #[test]
    fn the_first_ledger_9_event_starts_the_fold() {
        assert_eq!(next_phase(Phase::BeforeFork, Some(2_001_100), FORK), Ok((Action::Fold, Phase::Ledger9)));
        // A chain born on ledger 9 folds from its first event.
        assert_eq!(next_phase(Phase::Start, Some(2_001_000), FORK), Ok((Action::Fold, Phase::Ledger9)));
        assert_eq!(next_phase(Phase::Start, Some(FORK), FORK), Ok((Action::Fold, Phase::Ledger9)));
        assert_eq!(next_phase(Phase::Ledger9, Some(2_001_100), FORK), Ok((Action::Fold, Phase::Ledger9)));
    }

    #[test]
    fn an_event_with_no_version_is_read_on_the_ledger_of_the_fold_so_far() {
        assert_eq!(next_phase(Phase::Start, None, FORK), Ok((Action::Fold, Phase::Ledger9)));
        assert_eq!(next_phase(Phase::BeforeFork, None, FORK), Ok((Action::Pass, Phase::BeforeFork)));
        assert_eq!(next_phase(Phase::Ledger9, None, FORK), Ok((Action::Fold, Phase::Ledger9)));
    }

    #[test]
    fn a_ledger_8_event_after_the_fork_is_refused() {
        let err = next_phase(Phase::Ledger9, Some(1_000_000), FORK).unwrap_err();
        assert!(err.contains("out of order"), "{err}");
    }

    #[test]
    fn a_run_stopped_before_the_fork_keeps_only_how_far_it_read() {
        assert_eq!(outcome(Phase::Start, true), Outcome::NothingRead);
        assert_eq!(outcome(Phase::BeforeFork, true), Outcome::BeforeFork);
        // Caught up with no ledger-9 event yet: the crossing's empty ledger-9 state.
        assert_eq!(outcome(Phase::BeforeFork, false), Outcome::Reached);
        assert_eq!(outcome(Phase::Start, false), Outcome::Reached);
        assert_eq!(outcome(Phase::Ledger9, true), Outcome::Reached);
        assert_eq!(outcome(Phase::Ledger9, false), Outcome::Reached);
    }

    #[test]
    fn a_resumed_run_starts_where_its_checkpoint_stopped() {
        assert_eq!(resumed_phase(None), Phase::Start);
        assert_eq!(resumed_phase(Some(true)), Phase::BeforeFork);
        assert_eq!(resumed_phase(Some(false)), Phase::Ledger9);
        // A checkpoint from before the field existed was folding.
        let json = r#"{"ledger":9,"dust_state":"00","last_applied_event_id":1,"owned_generation_indices":[],"generation_frontier":0,"balance":"0","available_coins":0,"events_applied":1,"partial":true}"#;
        let cp: Checkpoint = serde_json::from_str(json).unwrap();
        assert_eq!(resumed_phase(Some(cp.before_fork)), Phase::Ledger9);
    }

    // Regression: with rustls linked on both ring and aws-lc-rs, a TLS client
    // config (what tungstenite builds for every wss:// indexer) panicked with
    // no process-level provider. After install_crypto_provider it builds.
    #[test]
    fn a_tls_client_config_builds_once_the_crypto_provider_is_installed() {
        install_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
        let _config = rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
    }
}
