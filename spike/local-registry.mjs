#!/usr/bin/env node
// Spike EB: a minimal npm registry for installing the spike's packages the way users install them.
//
//   node spike/local-registry.mjs <tarballDir> <port>
//
// Every *.tgz in <tarballDir> is served as a published version of the package it contains, with the
// manifest fields the public registry adds at publish time: dist.tarball, dist.integrity, dist.shasum
// and _hasShrinkwrap (true when the tarball holds npm-shrinkwrap.json; npm only honours a dependency's
// shrinkwrap when the registry says so). Any other package is fetched from registry.npmjs.org and
// passed through unchanged. Read only: it accepts no publish.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const [dir, portArg] = process.argv.slice(2);
if (!dir || !portArg) { console.error('usage: node spike/local-registry.mjs <tarballDir> <port>'); process.exit(2); }
const port = Number(portArg);
const base = `http://127.0.0.1:${port}`;
const UPSTREAM = 'https://registry.npmjs.org';

function loadLocal() {
  const pkgs = new Map();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.tgz'))) {
    const file = path.join(dir, f);
    const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n');
    const pj = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json'], { encoding: 'utf8' }));
    const bytes = readFileSync(file);
    const entry = {
      ...pj,
      _id: `${pj.name}@${pj.version}`,
      _hasShrinkwrap: listing.includes('package/npm-shrinkwrap.json'),
      dist: {
        tarball: `${base}/-/local/${encodeURIComponent(f)}`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        shasum: createHash('sha1').update(bytes).digest('hex'),
      },
    };
    const p = pkgs.get(pj.name) ?? { name: pj.name, 'dist-tags': {}, versions: {}, files: {} };
    p.versions[pj.version] = entry;
    p.files[f] = file;
    p['dist-tags'].latest = pj.version;
    pkgs.set(pj.name, p);
  }
  return pkgs;
}

http.createServer(async (req, res) => {
  const local = loadLocal();
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/-/local/')) {
    const f = url.slice('/-/local/'.length);
    for (const p of local.values()) if (p.files[f]) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(readFileSync(p.files[f])); }
    res.writeHead(404); return res.end();
  }
  const name = url.slice(1);
  if (local.has(name)) {
    const { files, ...packument } = local.get(name);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(packument));
  }
  try {
    const up = await fetch(UPSTREAM + req.url, { headers: { accept: req.headers.accept ?? 'application/json' } });
    const body = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
    res.end(body);
  } catch (e) { res.writeHead(502); res.end(String(e)); }
}).listen(port, '127.0.0.1', () => console.log(`spike registry on ${base}, serving ${dir}`));
