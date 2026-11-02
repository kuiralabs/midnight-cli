// A read-only npm registry on 127.0.0.1 serving packed tarballs as published
// versions, for installing mn the way users do before its packages are on npm.
//
// Each *.tgz in the folder is served as a version of the package it holds,
// with the fields the public registry adds at publish time: dist.tarball,
// dist.integrity, dist.shasum and _hasShrinkwrap (true when the tarball holds
// npm-shrinkwrap.json: npm honours a dependency's shrinkwrap only when its
// registry says so, so a tarball installed by path ignores it). Every other
// package passes through from registry.npmjs.org unchanged.
//
//   node scripts/local-registry.mjs <tarballDir> <port>

import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM = 'https://registry.npmjs.org';

/** The packages the tarballs in `dir` hold, as packuments, and the file behind each tarball URL. */
function packumentsIn(dir, base) {
  const packuments = new Map();
  const files = new Map();
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.tgz'))) {
    const file = join(dir, name);
    const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n');
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json'], { encoding: 'utf8' }));
    const bytes = readFileSync(file);
    const packument = packuments.get(manifest.name) ?? { name: manifest.name, 'dist-tags': {}, versions: {} };
    packument.versions[manifest.version] = {
      ...manifest,
      _id: `${manifest.name}@${manifest.version}`,
      _hasShrinkwrap: listing.includes('package/npm-shrinkwrap.json'),
      dist: {
        tarball: `${base}/-/local/${encodeURIComponent(name)}`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        shasum: createHash('sha1').update(bytes).digest('hex'),
      },
    };
    packument['dist-tags'].latest = manifest.version;
    packuments.set(manifest.name, packument);
    files.set(name, file);
  }
  return { packuments, files };
}

/** Serves the tarballs in `dir` on `port` (0: any free one); resolves to its URL and a close function. Rereads the folder when the tarballs in it change. */
export function startLocalRegistry(dir, port = 0) {
  return new Promise((resolve, reject) => {
    let base = '';
    let scanned = { key: '', packuments: new Map(), files: new Map() };
    const current = () => {
      const key = readdirSync(dir).filter((f) => f.endsWith('.tgz')).map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`).join('|');
      if (key !== scanned.key) scanned = { key, ...packumentsIn(dir, base) };
      return scanned;
    };
    const server = http.createServer(async (req, res) => {
      const { packuments, files } = current();
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (url.startsWith('/-/local/')) {
        const file = files.get(url.slice('/-/local/'.length));
        if (file === undefined) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(readFileSync(file));
        return;
      }
      const packument = packuments.get(url.slice(1));
      if (packument !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(packument));
        return;
      }
      try {
        const upstream = await fetch(UPSTREAM + req.url, { headers: { accept: req.headers.accept ?? 'application/json' } });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        res.writeHead(502);
        res.end(String(error));
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ url: base, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/**
 * The same registry in a process of its own, for a caller that runs npm
 * synchronously (and so can't answer npm's requests itself); resolves to its
 * URL and a close function.
 */
export function startLocalRegistryProcess(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dir, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`the local registry exited (${code}) before it was ready`)));
    child.stdout.on('data', (chunk) => {
      const ready = /registry on (http:\/\/\S+),/.exec(chunk.toString());
      if (ready) resolve({ url: ready[1], close: async () => { child.kill(); } });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, port] = process.argv.slice(2);
  if (!dir || !port) {
    console.error('usage: node scripts/local-registry.mjs <tarballDir> <port>');
    process.exit(2);
  }
  const { url } = await startLocalRegistry(dir, Number(port));
  console.log(`registry on ${url}, serving ${dir}`);
}
