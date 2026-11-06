// Types for what scripts/make-shrinkwrap.mjs exports that the tests import.
/** A published package's tarball and integrity, as `registry` serves them. */
export function registryDist(registry: string): (name: string, version: string) => { resolved: string; integrity: string };
/** The one field `npm view <name>@<version> <field> --json` printed (npm 11's value or npm 12's array of one). */
export function viewedField(output: string): unknown;
