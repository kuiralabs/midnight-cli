#!/usr/bin/env node
// Records what the built CLI does, so a refactor can prove it changed nothing:
// help in every form, the flags each command accepts, the --json output and
// exit code of commands that need no network, the MCP server's tools and
// resources, and which Midnight SDK packages load before any command runs.
//
// Usage:
//   node scripts/behaviour-snapshot.mjs record <dir>    write a snapshot to <dir>
//   node scripts/behaviour-snapshot.mjs compare <dir>   record afresh and diff against <dir>
// Add --no-build to use dist/ as it is instead of running `npm run build` first.
//
// Every run uses a new empty HOME, a fixed passphrase and no local-network
// detection, and touches no network. Paths, timestamps and random values are
// replaced by placeholders, so two runs of the same build are identical.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'dist', 'wallet.js');
const TIMEOUT_MS = 30_000;
const SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const CONTRACT_DIR = join(ROOT, 'node_modules', '@kuiralabs', 'midnight-account-chain', 'dist');
// Flags that act before a command runs: --mcp anywhere starts the MCP server
// instead, and the others print help or the version. They are not probed.
const GLOBAL_FLAGS = new Set(['help', 'h', 'json', 'version', 'v', 'mcp']);
// Flags some command accepts that no help text mentions (found 2026-10-29), so
// the documentation alone would not offer them.
const UNDOCUMENTED_FLAGS = ['verbose', 'intro', 'no-intro', 'tail', 'watch', 'goal', 'no-ai', 'redeploy', 'screen'];
// Commands that dispatch but that help does not list.
const UNLISTED_COMMANDS = ['status'];
const NOT_A_FLAG = 'zz-not-a-flag';

// ---------- running the CLI ----------

// `unset` names variables of the fixed environment a case runs without.
function cleanEnv(home, unset = []) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('MN_') && key !== 'NODE_OPTIONS' && key !== 'FORCE_COLOR') env[key] = value;
  }
  const fixed = { ...env, HOME: home, MN_NO_LOCAL_DETECT: '1', MN_PASSPHRASE: 'behaviour-snapshot', NO_COLOR: '1', TERM: 'dumb' };
  for (const key of unset) delete fixed[key];
  return fixed;
}

function normalise(text, home) {
  return text
    .split(home).join('<HOME>')
    .split(ROOT).join('<REPO>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TIME>')
    .replace(/\b\d{13}\b/g, '<EPOCH_MS>');
}

function runCli(home, args, nodeArgs = [], unset = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
    cwd: home, env: cleanEnv(home, unset), encoding: 'utf8', timeout: TIMEOUT_MS, input: '',
  });
  return {
    args,
    exit: result.error?.code === 'ETIMEDOUT' ? 'timeout' : result.status,
    stdout: normalise(result.stdout ?? '', home),
    stderr: normalise(result.stderr ?? '', home),
  };
}

// ---------- what is recorded ----------

function helpCases(home) {
  const cases = {
    'version': runCli(home, ['--version']),
    'help': runCli(home, ['help']),
    'help--json': runCli(home, ['help', '--json']),
    'help--agent': runCli(home, ['help', '--agent']),
    'manual--raw': runCli(home, ['manual', '--raw']),
  };
  for (const command of commandNames(cases['help--json'].stdout)) {
    cases[`help-${command}`] = runCli(home, ['help', command]);
  }
  return cases;
}

function commandNames(helpJson) {
  return JSON.parse(helpJson).commands.map((c) => c.name).sort();
}

// The flags a command accepts, found the way a user would: offer every flag
// the documentation mentions, and read back the ones the command refuses.
function acceptedFlags(home, helpCasesRecorded) {
  const docs = ['help--json', 'help--agent', 'manual--raw'].map((k) => helpCasesRecorded[k].stdout).join('\n');
  const candidates = [...new Set([...[...docs.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]), ...UNDOCUMENTED_FLAGS])]
    .filter((f) => !GLOBAL_FLAGS.has(f))
    .sort();
  const accepted = {};
  for (const command of [...commandNames(helpCasesRecorded['help--json'].stdout), ...UNLISTED_COMMANDS].sort()) {
    const offered = [...candidates, NOT_A_FLAG].map((f) => `--${f}`);
    const { stderr, exit } = runCli(home, [command, ...offered]);
    const refused = stderr.match(/Unknown flags? for "midnight [^"]+": ([^\n]+)/);
    if (!refused) {
      accepted[command] = { error: 'the command did not refuse an unknown flag', exit, stderr };
      continue;
    }
    const refusedSet = new Set(refused[1].split(', ').map((f) => f.replace(/^--?/, '')));
    accepted[command] = candidates.filter((f) => !refusedSet.has(f));
  }
  return { candidates, accepted };
}

// Commands that need no network, run in order in one HOME, so later ones see
// what earlier ones wrote. A third element names variables the case runs without.
const OFFLINE = [
  ['config-get-network', ['config', 'get', 'network', '--json']],
  ['config-set-network', ['config', 'set', 'network', 'undeployed']],
  ['config-get-network-after-set', ['config', 'get', 'network', '--json']],
  ['config-unset-network', ['config', 'unset', 'network']],
  ['config-no-action', ['config', '--json']],
  ['wallet-list-empty', ['wallet', 'list', '--json']],
  ['wallet-generate', ['wallet', 'generate', 'snap', '--seed', SEED, '--network', 'undeployed', '--json']],
  ['wallet-generate-again', ['wallet', 'generate', 'snap', '--seed', SEED, '--network', 'undeployed', '--json']],
  // No passphrase and no terminal to ask at: refused before it writes anything.
  ['wallet-generate-no-passphrase', ['wallet', 'generate', 'nopass', '--seed', SEED, '--network', 'undeployed', '--json'], ['MN_PASSPHRASE']],
  ['wallet-list', ['wallet', 'list', '--json']],
  ['wallet-info', ['wallet', 'info', '--json']],
  ['wallet-use', ['wallet', 'use', 'snap', '--json']],
  ['wallet-remove-last', ['wallet', 'remove', 'snap', '--json']],
  ['info', ['info', '--json']],
  ['address-from-seed', ['address', '--seed', SEED, '--network', 'undeployed', '--json']],
  ['address-from-wallet', ['address', '--wallet', 'snap', '--network', 'undeployed', '--json']],
  ['genesis-address', ['genesis-address', '--network', 'undeployed', '--json']],
  ['contract-inspect', ['contract', 'inspect', '--path', CONTRACT_DIR, '--json']],
  ['contract-inspect-missing', ['contract', 'inspect', '--json']],
  ['unknown-command', ['nosuchcmd']],
  ['unknown-command-json', ['nosuchcmd', '--json']],
  ['unknown-flag', ['balance', '--zzz']],
  ['unknown-flag-json', ['balance', '--zzz', '--json']],
  ['status-disabled', ['status', '--json']],
  ['transfer-no-args', ['transfer', '--json']],
  ['airdrop-no-amount', ['airdrop', '--json']],
  ['grant-no-subcommand', ['grant', '--json']],
  ['localnet-no-subcommand', ['localnet', '--json']],
  ['cache-no-subcommand', ['cache', '--json']],
];

function offlineCases(home) {
  const cases = {};
  for (const [name, args, unset = []] of OFFLINE) cases[name] = runCli(home, args, [], unset);
  cases['home-files'] = listFiles(join(home, '.midnight'), home);
  return cases;
}

function listFiles(dir, home) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => normalise(join(e.parentPath ?? e.path, e.name), home))
    .sort();
}

// Which Midnight SDK packages load before a command does anything.
function sdkLoads(home) {
  const log = join(home, 'loaded.log');
  const hooks = join(home, 'record-loads.mjs');
  writeFileSync(hooks, [
    "import { appendFileSync } from 'node:fs';",
    `const log = ${JSON.stringify(log)};`,
    'export async function resolve(specifier, context, next) {',
    '  const m = specifier.match(/^(@midnight(?:-ntwrk|ntwrk)\\/[^/]+|@kuiralabs\\/midnight-account[^/]*)/);',
    "  if (m) appendFileSync(log, m[1] + '\\n');",
    '  return next(specifier, context);',
    '}',
  ].join('\n'));
  const register = join(home, 'register.mjs');
  writeFileSync(register, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`);

  const loads = {};
  for (const [name, args] of [['version', ['--version']], ['help', ['help']], ['config-get', ['config', 'get', 'network']]]) {
    rmSync(log, { force: true });
    runCli(home, args, ['--import', pathToFileURL(register).href]);
    loads[name] = existsSync(log) ? [...new Set(readFileSync(log, 'utf8').trim().split('\n'))].sort() : [];
  }
  return loads;
}

// ---------- the MCP server ----------

function mcpSession(home, steps = listToolsAndResources) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, '--mcp'], { cwd: home, env: cleanEnv(home), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP server did not answer in time')); }, TIMEOUT_MS);
    let buffer = '';
    const waiting = new Map();
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      }
    });
    let nextId = 1;
    const request = (method, params = {}) => new Promise((done) => {
      const id = nextId++;
      waiting.set(id, done);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    (async () => {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'behaviour-snapshot', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const recorded = await steps(request);
      clearTimeout(timer);
      child.kill();
      resolvePromise(JSON.parse(normalise(JSON.stringify(recorded), home)));
    })().catch((error) => { clearTimeout(timer); child.kill(); reject(error); });
  });
}

async function listToolsAndResources(request) {
  const tools = await request('tools/list');
  const resources = await request('resources/list');
  const contents = {};
  for (const r of resources.result?.resources ?? []) contents[r.uri] = await request('resources/read', { uri: r.uri });
  return { tools, resources, contents };
}

// What an agent is asked to confirm, tool by tool, and what a tool does with a
// parameter it doesn't know. Endpoints point at a closed port, so no check
// reaches a chain; a check that needs one records its refusal.
const CLOSED = 'http://127.0.0.1:1';
const CONFIRMATION_CALLS = [
  ['midnight_transfer', { to: 'bob', amount: '1', network: 'undeployed' }],
  ['midnight_contract_deploy', { path: '<DAPP>', network: 'undeployed' }],
  ['midnight_contract_call', { path: '<DAPP>', address: 'ab'.repeat(32), circuit: 'increment', network: 'undeployed' }],
  ['midnight_grant_deploy', { network: 'undeployed' }],
  ['midnight_grant_deposit', { amount: '1', network: 'undeployed' }],
  ['midnight_grant_issue', { network: 'undeployed' }],
  ['midnight_grant_revoke', { grant: '1', network: 'undeployed' }],
  ['midnight_grant_revoke_all', { network: 'undeployed' }],
];

function mcpConfirmations(home) {
  for (const args of [
    ['config', 'set', 'node', CLOSED.replace('http', 'ws')], ['config', 'set', 'indexer-ws', `${CLOSED.replace('http', 'ws')}/api/v4/graphql/ws`],
    ['config', 'set', 'proof-server', CLOSED],
    ['wallet', 'generate', 'snap', '--seed', SEED, '--network', 'undeployed'], ['wallet', 'generate', 'bob', '--network', 'undeployed'],
    ['wallet', 'use', 'snap'],
  ]) runCli(home, args);
  // A compiled contract's description, as a dApp folder holds it (one circuit, no witnesses).
  const dapp = join(home, 'dapp');
  mkdirSync(join(dapp, 'managed', 'counter', 'compiler'), { recursive: true });
  writeFileSync(join(dapp, 'managed', 'counter', 'compiler', 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.35.0', 'language-version': '0.27.0', 'runtime-version': '0.20.0',
    circuits: [{ name: 'increment', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } }],
    witnesses: [],
  }));
  return mcpSession(home, async (request) => {
    const calls = {};
    for (const [name, args] of CONFIRMATION_CALLS) {
      const withDapp = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v === '<DAPP>' ? dapp : v]));
      calls[name] = await request('tools/call', { name, arguments: withDapp });
    }
    calls['unknown-parameter'] = await request('tools/call', { name: 'midnight_config_get', arguments: { key: 'network', [NOT_A_FLAG]: '1' } });
    // Last: it removes a wallet.
    calls['midnight_wallet_remove'] = await request('tools/call', { name: 'midnight_wallet_remove', arguments: { name: 'bob' } });
    // The pending token is random: recorded as a placeholder.
    return JSON.parse(JSON.stringify(calls).replace(/\\"token\\":\s*\\"[^\\"]+\\"/g, '\\"token\\": \\"<TOKEN>\\"'));
  });
}

// ---------- recording and comparing ----------

async function record(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const write = (name, value) => {
    const file = join(dir, `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  };

  const home = mkdtempSync(join(tmpdir(), 'mn-snapshot-'));
  try {
    const help = helpCases(home);
    for (const [name, value] of Object.entries(help)) write(`help/${name}`, value);
    write('flags', acceptedFlags(home, help));
    write('sdk-loads', sdkLoads(home));
    write('mcp', await mcpSession(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const offlineHome = mkdtempSync(join(tmpdir(), 'mn-snapshot-'));
  try {
    for (const [name, value] of Object.entries(offlineCases(offlineHome))) write(`offline/${name}`, value);
  } finally {
    rmSync(offlineHome, { recursive: true, force: true });
  }

  const confirmHome = mkdtempSync(join(tmpdir(), 'mn-snapshot-'));
  try {
    write('mcp-confirmations', await mcpConfirmations(confirmHome));
  } finally {
    rmSync(confirmHome, { recursive: true, force: true });
  }
}

function build() {
  const result = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    process.exit(2);
  }
}

const [mode, target, ...rest] = process.argv.slice(2);
if (!['record', 'compare'].includes(mode) || !target) {
  process.stderr.write('Usage: node scripts/behaviour-snapshot.mjs <record|compare> <dir> [--no-build]\n');
  process.exit(2);
}
if (!rest.includes('--no-build')) build();

if (mode === 'record') {
  await record(resolve(target));
  process.stdout.write(`Snapshot written to ${resolve(target)}\n`);
} else {
  const fresh = mkdtempSync(join(tmpdir(), 'mn-snapshot-fresh-'));
  await record(fresh);
  // Finder's .DS_Store in a snapshot folder someone opened is no behaviour of mn's.
  const diff = spawnSync('diff', ['-ru', '-x', '.DS_Store', resolve(target), fresh], { encoding: 'utf8' });
  if (diff.status === 0) {
    process.stdout.write('Behaviour unchanged.\n');
    rmSync(fresh, { recursive: true, force: true });
  } else {
    process.stdout.write(diff.stdout);
    process.stdout.write(`\nBehaviour changed. The fresh snapshot is in ${fresh}\n`);
    process.exit(1);
  }
}
