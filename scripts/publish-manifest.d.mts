// Types for what scripts/publish-manifest.mjs exports when imported.
/** The development-only export condition: an entry point's TypeScript source. */
export const SOURCE_CONDITION: string;
/** The manifest a package is published with: its own, the source condition taken out of `exports`. */
export function publishedManifest<T extends { exports?: unknown }>(manifest: T): T;
/** Packs the package in `dir` into `destination` with its published manifest, its own package.json put back; returns the tarball's path. */
export function packPublished(dir: string, destination: string): string;
