// Package metadata — inlined by bun at build time
// Single source of truth: no createRequire, no runtime file reads

import pkg from '../../package.json';

export const PKG_NAME: string = pkg.name;
export const PKG_VERSION: string = pkg.version;
export const PKG_DESCRIPTION: string = pkg.description;

// The repository's web address, from `repository.url` (git+https://….git).
export const PKG_REPOSITORY_URL: string = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
