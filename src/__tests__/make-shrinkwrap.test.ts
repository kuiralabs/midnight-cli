// The shrinkwrap's tarballs and integrity come from `npm view ... dist --json`,
// whose output changed shape in npm 12 (the release job installs the latest npm).

import { describe, expect, it } from 'vitest';
import { shrinkwrapFrom, viewedField } from '../../scripts/make-shrinkwrap.mjs';

describe("the field in npm view's output", () => {
  // As npm prints `npm view @kuiralabs/midnight-cli-core@0.1.0-rc.2 dist --json`.
  const dist = {
    shasum: '542a05420f0c64de2ff4e164e8d60aa00dd0411d',
    tarball: 'https://registry.npmjs.org/@kuiralabs/midnight-cli-core/-/midnight-cli-core-0.1.0-rc.2.tgz',
    integrity: 'sha512-example',
  };

  it('is read from npm 11 (the value) and npm 12 (an array of one)', () => {
    expect(viewedField(JSON.stringify(dist))).toStrictEqual(dist);
    expect(viewedField(JSON.stringify([dist]))).toStrictEqual(dist);
  });

  it('is refused when npm 12 prints other than one value', () => {
    expect(() => viewedField('[]')).toThrow('0 values, not one');
    expect(() => viewedField(JSON.stringify([dist, dist]))).toThrow('2 values, not one');
  });
});

describe('a dependency installed from a tarball on disk', () => {
  // An engine depending on a build not yet published, as the lockfile records
  // it: the shrinkwrap names it by version, from the registry, as it will be
  // once published. The tarball's version is read from the tarball itself, so
  // here the manifest already names the version the lockfile resolved.
  const lock = {
    packages: {
      '': { name: 'root', workspaces: ['packages/engine'] },
      'node_modules/@x/engine': { resolved: 'packages/engine', link: true },
      'packages/engine': { name: '@x/engine', version: '1.0.0' },
      'node_modules/@x/chain': { version: '0.4.0-rc.0', resolved: 'file:../../local-tarballs/x-chain-0.4.0-rc.0.tgz', integrity: 'sha512-local', dependencies: { tiny: '1.0.0' } },
      'node_modules/tiny': { version: '1.0.0', resolved: 'https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz', integrity: 'sha512-tiny' },
    },
  };
  const manifest = { name: '@x/engine', version: '1.0.0', dependencies: { '@x/chain': '0.4.0-rc.0' } };
  const dist = (name: string, version: string) => ({ resolved: `http://127.0.0.1:4873/${name}/-/${version}.tgz`, integrity: `sha512-served-${name}` });

  it('takes its tarball and integrity from the registry; registry packages keep theirs', () => {
    const { packages } = shrinkwrapFrom(lock, manifest, dist, { at: 'packages/engine' });
    expect(packages['node_modules/@x/chain']).toMatchObject({ version: '0.4.0-rc.0', resolved: 'http://127.0.0.1:4873/@x/chain/-/0.4.0-rc.0.tgz', integrity: 'sha512-served-@x/chain' });
    expect(packages['node_modules/tiny']).toMatchObject({ resolved: 'https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz', integrity: 'sha512-tiny' });
  });
});
