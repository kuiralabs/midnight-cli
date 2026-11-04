// What a user gets from npm, checked: packs mn and the workspace packages it
// depends on, serves them from a local registry as npm serves published
// packages, installs mn globally from it into an empty prefix, and checks the
// tree the install holds still works: one copy of each WASM package per SDK
// engine (the shrinkwrap mn ships keeps each engine's set apart), each engine
// loading, the packages a contract run's script imports, and the files the
// code reads at run time.
//
// The test suite runs on the lockfile's tree, which a consumer never sees. Two
// features broke that way without a test noticing: a newer @scure/base refused
// every shielded address, and (on the ledger-8 line) a second copy of the ledger
// made contract calls fail with "expected instance of LedgerParameters". A
// third thing only a packed install shows: a file the code reads at run time
// that the package's `files` list leaves out (on the ledger-8 line the MCP
// server's core skill document was one).
//
//   node scripts/fresh-install-check.mjs      (after `npm run build`)

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packRelease } from './pack-release.mjs';

const repo = new URL('..', import.meta.url).pathname;
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Every installed copy of a package under `root`, as its versions. */
function copiesOf(root, name) {
  const found = [];
  const walk = (dir) => {
    const modules = join(dir, 'node_modules');
    if (!existsSync(modules)) return;
    const manifest = join(modules, name, 'package.json');
    if (existsSync(manifest)) found.push(JSON.parse(readFileSync(manifest, 'utf-8')).version);
    for (const entry of readdirSync(modules)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) for (const scoped of readdirSync(join(modules, entry))) walk(join(modules, entry, scoped));
      else walk(join(modules, entry));
    }
  };
  walk(root);
  return found;
}

/**
 * Every copy of `name` that the package in `dir` reaches through its
 * dependencies, by Node's resolution from each package's folder: the copies a
 * process that loads it can load.
 */
function resolvedCopies(dir, name) {
  const found = new Map();
  const seen = new Set();
  const resolveFrom = (from, dep) => {
    for (let at = from; ; at = dirname(at)) {
      const manifest = join(at, 'node_modules', dep, 'package.json');
      if (existsSync(manifest)) return realpathSync(dirname(manifest));
      if (dirname(at) === at) return null;
    }
  };
  // By the name code imports it under: an npm alias of the same package under another name is another package to its importers.
  const walk = (pkgDir) => {
    if (seen.has(pkgDir)) return;
    seen.add(pkgDir);
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      const resolved = resolveFrom(pkgDir, dep);
      if (resolved === null) continue;
      if (dep === name) found.set(resolved, JSON.parse(readFileSync(join(resolved, 'package.json'), 'utf-8')).version);
      walk(resolved);
    }
  };
  walk(realpathSync(dir));
  return [...found].map(([at, version]) => ({ dir: at, version }));
}

/**
 * What the MCP server at `server` offers, asked over stdio as an MCP client
 * would: the names of its tools, and every resource it lists with its text
 * (or with the error reading it gave).
 */
function askMcpServer(server, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(server, [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const results = [];
    const waiting = new Map();
    let nextId = 0;
    let buffered = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('the MCP server did not answer in 60 s')); }, 60_000);
    const done = (outcome) => { clearTimeout(timer); child.kill(); outcome(); };
    const request = (method, params) => new Promise((answer) => {
      const id = ++nextId;
      waiting.set(id, answer);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    child.on('error', (error) => done(() => reject(error)));
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString();
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    });
    (async () => {
      await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fresh-install-check', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const tools = (await request('tools/list', {})).result.tools.map((tool) => tool.name);
      const listed = await request('resources/list', {});
      for (const { uri } of listed.result.resources) {
        const read = await request('resources/read', { uri });
        results.push({ uri, text: read.result?.contents?.[0]?.text ?? '', error: read.error?.message });
      }
      done(() => resolve({ tools, resources: results }));
    })().catch((error) => done(() => reject(error)));
  });
}

const failures = [];
const check = (what, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(what);
};

const work = mkdtempSync(join(tmpdir(), 'mn-fresh-install-'));
let registry;
try {
  // mn and the workspace packages it depends on, as a release publishes them,
  // served by a local registry as npm installs a published package.
  const packed = await packRelease(join(work, 'registry'));
  registry = packed.registry;
  const { workspaces } = packed;
  const manifest = { name: packed.name, version: packed.version };

  const version = manifest.version;
  const prefix = join(work, 'prefix');
  run('npm', ['install', '-g', '--prefix', prefix, '--cache', join(work, 'npm-cache'), '--registry', registry.url, '--no-audit', '--no-fund', `${manifest.name}@${version}`], work);
  const installed = join(prefix, 'lib', 'node_modules', manifest.name);
  const mn = join(prefix, 'bin', 'mn');
  check('the installed mn runs', run(mn, ['--version'], work).trim() === version, version);
  check('the package shipped its shrinkwrap', existsSync(join(installed, 'npm-shrinkwrap.json')));

  // One copy of each workspace package: a second copy of core's module state (its settings, its typed errors) splits the process.
  for (const { name } of workspaces) {
    const copies = copiesOf(installed, name);
    check(`one copy of ${name}`, copies.length === 1, copies.join(', '));
  }
  // Each engine resolves one copy of each WASM package: an object made by one copy is refused by another.
  for (const { name } of workspaces.filter(({ name }) => name.startsWith('@kuiralabs/midnight-engine-'))) {
    const engine = join(installed, 'node_modules', name);
    for (const sdk of ['@midnightntwrk/ledger-v9', '@midnight-ntwrk/compact-runtime', '@midnightntwrk/onchain-runtime-v4']) {
      const copies = resolvedCopies(engine, sdk);
      check(`${name} resolves one copy of ${sdk}`, copies.length === 1, copies.map((c) => `${c.version} ${c.dir.slice(realpathSync(installed).length)}`).join(', '));
    }
  }

  // A shielded address is longer than bech32's 90 characters; the address
  // library must still read the one the installed mn derives.
  const home = join(work, 'home');
  // The installed mn in a home of its own, run without a terminal: it seals
  // the wallet under a passphrase, so it gets one, as any unattended run does.
  const env = { ...process.env, HOME: home, MN_PASSPHRASE: 'fresh install check' };
  const wallet = JSON.parse(execFileSync(mn, ['wallet', 'generate', 'check', '--json'], {
    cwd: work, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], env,
  }));
  const address = wallet.shieldedAddresses.undeployed;
  const parsed = run(process.execPath, ['--input-type=module', '-e', `
    import { MidnightBech32m, ShieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
    try {
      MidnightBech32m.parse(${JSON.stringify(address)}).decode(ShieldedAddress, 'undeployed');
      console.log('parsed');
    } catch (error) {
      console.log(error.message);
    }
  `], join(installed, 'node_modules', '@kuiralabs', 'midnight-engine-rc'));
  check('a shielded address parses', parsed.trim() === 'parsed' && address.length > 90, `${address.length} characters${parsed.trim() === 'parsed' ? '' : `, ${parsed.trim()}`}`);

  // Each engine loads from the install: deriving a network's address loads the engine of its set.
  for (const [network, prefixOf] of [['undeployed', 'mn_addr_undeployed1'], ['stagenet', 'mn_addr_stagenet1']]) {
    let derived = '';
    try {
      derived = JSON.parse(execFileSync(mn, ['address', '--wallet', 'check', '--network', network, '--json'], { cwd: work, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env })).address ?? '';
    } catch (error) {
      derived = String(error.stderr ?? error.message).trim().split('\n').pop();
    }
    check(`the ${network === 'stagenet' ? 'beta' : 'rc'} engine derives a ${network} address`, derived.startsWith(prefixOf), derived.slice(0, 40));
  }

  // A contract run from the install: the contract package's runner has the
  // network's engine write the script, links the packages it imports into the
  // dApp's folder from where the engine finds each by name (never by a path
  // from the runner's own package), and runs it with Node. Each engine finds
  // every package its scripts import; a state read of a compiled contract gets
  // as far as asking the indexer (every import resolved, the dApp's contract
  // module loaded), which refuses the connection, reported as NETWORK_ERROR
  // from the script's marked line; and the dApp's folder is left as it was.
  for (const [network, set] of [['undeployed', 'rc'], ['stagenet', 'beta']]) {
    const dapp = join(work, `dapp-${set}`);
    const ran = JSON.parse(run(process.execPath, ['--input-type=module', '-e', `
      import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createHost, getNetworkConfig } from '@kuiralabs/midnight-cli-core';
      import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
      import { createBetaEngine } from '@kuiralabs/midnight-engine-beta';
      import { runState } from '@kuiralabs/midnight-contract';
      const [dapp, network, home] = process.argv.slice(1);
      const host = createHost({
        paths: { stateRoot: join(home, '.midnight'), home },
        engineLoader: async (set, host) => set === 'beta' ? createBetaEngine(host) : createRcEngine(host),
      });
      const { scripts } = (await host.engines.for(network)).contracts;
      const missing = scripts.packages.filter((name) => scripts.packageFolder(name) === null);
      const managedDir = join(dapp, 'managed', 'counter');
      mkdirSync(join(managedDir, 'compiler'), { recursive: true });
      mkdirSync(join(managedDir, 'contract'), { recursive: true });
      writeFileSync(join(dapp, 'package.json'), JSON.stringify({ name: 'dapp', private: true, type: 'module' }));
      writeFileSync(join(managedDir, 'compiler', 'contract-info.json'), JSON.stringify({ 'compiler-version': '0.35.0', 'language-version': '0.27.0', 'runtime-version': scripts.compactRuntimeVersion, circuits: [], witnesses: [] }));
      writeFileSync(join(managedDir, 'contract', 'index.js'), 'export function ledger() { return {}; }\\n');
      const before = readdirSync(dapp).sort();
      const said = [];
      const networkConfig = { ...getNetworkConfig(network), indexer: 'http://127.0.0.1:9/api/v4/graphql', indexerWS: 'ws://127.0.0.1:9/api/v4/graphql/ws', node: 'ws://127.0.0.1:9', proofServer: 'http://127.0.0.1:9' };
      let failed;
      try {
        await runState({ dappDir: dapp, network, root: join(home, '.midnight'), engines: host.engines, networkConfig, managedDir, contractName: 'counter', contractAddress: 'ab'.repeat(32), onMessage: (message) => said.push(message) });
      } catch (error) {
        failed = { name: error.name, code: error.code, message: error.message };
      }
      console.log(JSON.stringify({ packages: scripts.packages.length, missing, said, failed, leftAsItWas: JSON.stringify(readdirSync(dapp).sort()) === JSON.stringify(before) }));
    `, dapp, network, home], installed));
    check(`the ${set} engine finds the ${ran.packages} packages its contract scripts import`, ran.missing.length === 0, ran.missing.length > 0 ? `not found: ${ran.missing.join(', ')}` : '');
    const reached = ran.said.includes('Querying contract state...') && ran.failed?.name === 'ContractScriptError' && ran.failed?.code === 'NETWORK_ERROR';
    check(`a ${network} contract state read runs its script in a dApp, as far as the indexer`, reached, ran.failed === undefined ? 'it did not fail' : `${ran.failed.name} ${ran.failed.code ?? '(no code)'}: ${ran.failed.message.split('\n').pop()}`);
    check(`the ${network} run leaves the dApp's folder as it was`, ran.leftAsItWas);
  }

  // mn grant drives the account package it installed: its owner records load
  // from the installed tree and answer that the new wallet has no account.
  // Asking that reaches no chain and opens no proving-artefact cache (the
  // release gate's live run checks the cache, around the first deploy).
  let grant = '';
  try {
    execFileSync(mn, ['grant', 'status', '--wallet', 'check', '--network', 'undeployed', '--node', 'ws://127.0.0.1:9', '--indexer-ws', 'ws://127.0.0.1:9/api/v4/graphql/ws', '--proof-server', 'http://127.0.0.1:9'], {
      cwd: work, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    grant = 'answered without an error';
  } catch (error) {
    grant = String(error.stderr ?? error.message);
  }
  check('mn grant drives the installed account package', /Wallet "check" has no account on undeployed yet/.test(grant), grant.includes('has no account') ? 'no account yet, as for a new wallet' : grant.trim().split('\n').slice(-2).join(' | '));
  check('it opens no proving-artefact cache', !existsSync(join(home, '.midnight', 'account-artifacts')), 'none under ~/.midnight');
  const chains = copiesOf(installed, '@kuiralabs/midnight-account-chain');
  check('one copy of @kuiralabs/midnight-account-chain', chains.length === 1, chains.join(', '));

  // The MCP server reads its skill documents from the installed package.
  const { tools, resources } = await askMcpServer(join(prefix, 'bin', 'midnight-wallet-mcp'), env);
  check('the MCP server lists its skill resources', resources.length >= 2, `${resources.length}`);
  for (const { uri, text, error } of resources) {
    check(`the MCP server serves ${uri}`, error === undefined && text.length > 0, error ? error.replace(work, '<install>') : `${text.length} characters`);
    // An agent calls what the skill tells it to: every tool call it shows must be a tool the server has.
    const named = [...new Set([...text.matchAll(/\b(midnight_[a-z_]+)\(/g)].map((match) => match[1]))];
    const unknown = named.filter((name) => !tools.includes(name));
    check(`${uri} names only tools the server has`, unknown.length === 0, unknown.length > 0 ? `not a tool: ${unknown.join(', ')}` : `${named.length} of ${tools.length} tools named`);
  }

  // A program that loads an engine without mn: it installs core, chain and the
  // engines from the registry, each engine with the shrinkwrap it ships, and
  // gets each engine's SDK set once beside one core and one chain it shares.
  const outside = join(work, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'outside', private: true, type: 'module' }));
  run('npm', ['install', '--cache', join(work, 'npm-cache'), '--registry', registry.url, '--no-audit', '--no-fund', ...workspaces.map(({ name, version }) => `${name}@${version}`)], outside);
  for (const { name } of workspaces.filter(({ name }) => !name.startsWith('@kuiralabs/midnight-engine-'))) {
    const copies = copiesOf(outside, name);
    check(`a program outside mn: one copy of ${name}`, copies.length === 1, copies.join(', '));
  }
  for (const { name } of workspaces.filter(({ name }) => name.startsWith('@kuiralabs/midnight-engine-'))) {
    const engine = join(outside, 'node_modules', name);
    for (const sdk of ['@midnightntwrk/ledger-v9', '@midnight-ntwrk/compact-runtime', '@midnightntwrk/onchain-runtime-v4']) {
      const copies = resolvedCopies(engine, sdk);
      check(`a program outside mn: ${name} resolves one copy of ${sdk}`, copies.length === 1, copies.map((c) => `${c.version} ${c.dir.slice(realpathSync(outside).length)}`).join(', '));
    }
  }
  writeFileSync(join(outside, 'load.mjs'), `
    import { createHost } from '@kuiralabs/midnight-cli-core';
    const host = createHost({
      paths: { stateRoot: ${JSON.stringify(join(outside, 'state'))}, home: ${JSON.stringify(outside)} },
      engineLoader: async (set, host) => set === 'beta' ? (await import('@kuiralabs/midnight-engine-beta')).createBetaEngine(host) : (await import('@kuiralabs/midnight-engine-rc')).createRcEngine(host),
    });
    try { console.log((await host.engines.for(process.argv[2])).set); } catch (error) { console.log(error.code ?? error.message); }
  `);
  for (const [network, set] of [['undeployed', 'rc'], ['stagenet', 'beta']]) {
    const loaded = run(process.execPath, ['load.mjs', network], outside).trim();
    check(`a program outside mn loads the ${set} engine for ${network}`, loaded === set, loaded);
  }

  // The installed packages are imported by their entry points alone: each
  // named entry point loads, the published manifests name no source file,
  // and a module that is not an entry point is refused.
  writeFileSync(join(outside, 'entry.mjs'), `
    try { await import(process.argv[2]); console.log('loaded'); } catch (error) { console.log(error.code ?? error.message); }
  `);
  for (const { name } of workspaces) {
    const manifest = readFileSync(join(outside, 'node_modules', name, 'package.json'), 'utf-8');
    check(`a program outside mn: ${name}'s manifest names no source file`, !manifest.includes('midnight-cli-source'));
    for (const entry of Object.keys(JSON.parse(manifest).exports).filter((key) => !key.includes('*'))) {
      const specifier = entry === '.' ? name : `${name}${entry.slice(1)}`;
      const loaded = run(process.execPath, ['entry.mjs', specifier], outside).trim();
      check(`a program outside mn imports ${specifier}`, loaded === 'loaded', loaded);
    }
  }
  // A module of each package that is not an entry point, named as the open
  // `./*` used to export it (core's lib/errors as `<name>/lib/errors`).
  for (const [name, deepPath] of [
    ['@kuiralabs/midnight-cli-core', 'lib/errors'],
    ['@kuiralabs/midnight-chain', 'lib/chain-id'],
    ['@kuiralabs/midnight-engine-rc', 'derive-address'],
    ['@kuiralabs/midnight-engine-beta', 'derive-address'],
    ['@kuiralabs/midnight-wallet', 'lib/passphrase'],
    ['@kuiralabs/midnight-contract', 'lib/contract/runner'],
    ['@kuiralabs/midnight-connect', 'lib/ws-rpc'],
    ['@kuiralabs/midnight-dev', 'lib/localnet'],
  ]) {
    check(`a program outside mn finds ${name}'s ${deepPath} built`, existsSync(join(outside, 'node_modules', name, 'dist', `${deepPath}.js`)));
    const deep = run(process.execPath, ['entry.mjs', `${name}/${deepPath}`], outside).trim();
    check(`a program outside mn is refused ${name}/${deepPath}`, deep === 'ERR_PACKAGE_PATH_NOT_EXPORTED', deep);
  }
} catch (error) {
  check('the fresh install and its checks ran', false, String(error.stderr || error.message).trim().split('\n').slice(-3).join(' | '));
} finally {
  await registry?.close();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed on a fresh install. The lockfile's tree passes its tests; this one is what users get.`);
  process.exit(1);
}
console.log('\nA fresh install works.');
