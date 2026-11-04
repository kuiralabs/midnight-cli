// Types for what scripts/pack-release.mjs exports when imported.
/** Whether a workspace package ships a shrinkwrap of its own: each engine and grant. */
export function shipsShrinkwrap(name: string): boolean;
/** Packs the release into `dir` for a registry on `port` (0: any free one), leaving that registry running. */
export function packRelease(dir: string, port?: number): Promise<{
  registry: { url: string; close(): Promise<void> };
  name: string;
  version: string;
  workspaces: { folder: string; name: string; version: string }[];
}>;
