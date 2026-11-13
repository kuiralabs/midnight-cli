// Types for what scripts/make-shrinkwrap.mjs exports that the tests import.
/** A published package's tarball and integrity, as `registry` serves them. */
export function registryDist(registry: string): (name: string, version: string) => { resolved: string; integrity: string };
/** A published package's lockfile entry (version, tarball, integrity, os, cpu, libc), as `registry` serves it. */
export function registryPackage(registry: string): (name: string, version: string) => Record<string, unknown>;
/** The one field `npm view <name>@<version> <field> --json` printed (npm 11's value or npm 12's array of one). */
export function viewedField(output: string): unknown;
/** The shrinkwrap of the package at `at` in the workspace, from the lockfile and its manifest; see make-shrinkwrap.mjs. */
export function shrinkwrapFrom(lock: { packages: Record<string, Record<string, unknown>> }, manifest: Record<string, unknown>, dist: (name: string, version: string) => { resolved: string; integrity: string }, options?: { at?: string; leaveOut?: string[]; dir?: string; published?: (name: string, version: string) => Record<string, unknown> }): { name: string; version: string; lockfileVersion: number; requires: boolean; packages: Record<string, Record<string, unknown>> };
