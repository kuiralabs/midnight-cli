// Types for what scripts/publish-manifest.mjs exports when imported.
/** The development-only export condition: an entry point's TypeScript source. */
export const SOURCE_CONDITION: string;
/** The manifest a package is published with: its own, the source condition taken out of `exports`. */
export function publishedManifest<T extends { exports?: unknown }>(manifest: T): T;
/** Packs the package in `dir` into `destination` with its published manifest, its own package.json put back; returns the tarball's path. */
export function packPublished(dir: string, destination: string): string;
/** The tarball's file name in what `npm pack --json` printed for one package (npm 11's array or npm 12's object). */
export function packedFilename(output: string): string;
/** Whether a dependency spec installs a package from a tarball on disk (`file:<path>.tgz`). */
export function isLocalTarball(spec: unknown): boolean;
/** The name and version of the package a tarball on disk holds. */
export function tarballPackage(path: string): { name: string; version: string };
/** The manifest with each dependency installed from a tarball on disk named by that tarball's version (paths resolved from `dir`). */
export function withLocalTarballsAsVersions<T extends Record<string, unknown>>(manifest: T, dir: string, version?: (path: string) => string): T;
/** The tarballs on disk the manifest in `dir` installs dependencies from, as absolute paths. */
export function localTarballsOf(dir: string): string[];
