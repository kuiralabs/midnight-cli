// The shrinkwrap's tarballs and integrity come from `npm view ... dist --json`,
// whose output changed shape in npm 12 (the release job installs the latest npm).

import { describe, expect, it } from 'vitest';
import { viewedField } from '../../scripts/make-shrinkwrap.mjs';

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
