# Publishing midnight-wallet-cli

Releases are **tag-triggered**. Pushing a `v*` tag runs `.github/workflows/release-sidecar.yml`, which builds the native dust-sync sidecar for every platform, typechecks and runs the full test suite, then publishes 14 packages: the five per-platform `@kuiralabs/dust-sync-*` packages, the eight `@kuiralabs/midnight-*` workspace packages mn depends on, and mn (`midnight-wallet-cli`). Do **not** run `npm publish` by hand — that would ship the main package without the platform binaries or the workspace packages it pins, leaving its dependencies pointing at packages that were never published.

Publish with npm 11 (the release job installs `npm@11`): npm 12 neither packs nor reads `npm-shrinkwrap.json`, which mn, the engine and grant ship. Users install with npm 11 or older for the same reason.

## Build & verify locally first

```bash
npm run build          # bun-bundles dist/wallet.js + dist/mcp-server.js (Node-only at runtime)
npx tsc --noEmit
npx vitest run
node dist/wallet.js help
```

## Local install smoke test

```bash
npm pack                                   # -> midnight-wallet-cli-<version>.tgz
npm install -g ./midnight-wallet-cli-*.tgz
midnight help && mn help
npm uninstall -g midnight-wallet-cli
```

The main tarball ships only `dist/`, `docs/SKILL.md`, `docs/SKILL-CORE.md`, `NOTICE` and, in a release, `npm-shrinkwrap.json` (see `files` in `package.json`), besides the `README.md`, `LICENSE` and `package.json` npm always packs. Anything else the code reads at run time has to be added there: `node scripts/fresh-install-check.mjs` installs the packed tarball into an empty directory and checks it, MCP resources included. The native binaries live in the separate `@kuiralabs/dust-sync-*` packages, not this tarball.

## Cut a release

1. Bump the version in `package.json`, and the @kuiralabs packages' version (one version for all of them, e.g. `0.1.0`) in every `packages/*/package.json`, the five `packages/dust-sync-*` platform packages included, along with mn's `dependencies` on the workspace packages and their dependencies on each other (exact versions); then `npm install --package-lock-only`. The release workflow pins mn's `optionalDependencies` to the platform packages' version (exactly) with `node scripts/sync-sidecar-versions.mjs`; run it by hand only to check, and don't commit what it writes, since `npm ci` can't install a platform package before it is published.
2. Update `CHANGELOG.md` (dated section), commit, and push `main`.
3. Tag and push:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
4. The `release` workflow:
   - on native runners per platform, builds `dust-sync` with `cargo build --release --locked` (the `--locked` keeps the `midnight-ledger-v9 =1.0.0` pins so the serialized `DustLocalState` round-trips byte-identically with the engine's `@midnightntwrk/ledger-v9`), runs its tests and checks that `dust-sync --ledger` prints `9` where the runner can run the binary (all but darwin-x64, which is cross-compiled);
   - checks that the tag (without the leading `v`) equals `package.json`'s `version`, then installs (`npm ci`), typechecks, builds and runs the full test suite; any failure stops it before anything is published;
   - publishes the five `@kuiralabs/dust-sync-<os>-<arch>` packages, each with its binary, and pins mn's `optionalDependencies` to them;
   - publishes the eight workspace packages in dependency order (`cli-core`, `chain`, `engine-rc`, `wallet`, `connect`, `contract`, `dev`, `grant`), the engine and grant each with the `npm-shrinkwrap.json` `scripts/make-shrinkwrap.mjs` writes, each packed by `scripts/publish-manifest.mjs` with the manifest it is published with;
   - writes mn's shrinkwrap and publishes `midnight-wallet-cli`.

   A package whose version is on npm already is skipped, so a failed release can be tagged again.

**Dist-tags.** Each package goes to the dist-tag of its own version: a prerelease version (with a `-`, e.g. `0.6.0-rc.0`) to `next`, so it never becomes `latest`, and a stable one to `latest`. mn and the @kuiralabs packages carry different versions, so a release can publish a stable mn on packages that are prereleases, or the other way round. Bump `package.json` to the version the tag names; the tag check above applies to prereleases too.

Dry-run the build without publishing via the workflow's `workflow_dispatch` (`dry_run: true`) — it builds all five targets and skips the publish job.

## Auth: OIDC trusted publishing

Publishing uses **OIDC trusted publishing** (no long-lived secret) once each of the 14 packages has a trusted publisher configured on npmjs.com (repo `kuiralabs/midnight-cli`, workflow `release-sidecar.yml`).

**First release bootstrap** — a trusted publisher can only be attached to a package that already exists, so the very first publish needs a one-time classic **Automation** token stored as the `NPM_TOKEN` repo secret. After that release, configure the 14 trusted publishers and the secret can be deleted; every later tag publishes tokenless. The five `@kuiralabs/dust-sync-*` platform packages are new names on npm (they were `@nel349/dust-sync-*` up to 0.5.x), so their first publish needs that token too, and a trusted publisher each afterwards.

## Notes

- `bun build --packages external` keeps runtime deps as imports (resolved via `node_modules`); consumers only need Node.js >= 22, as every package's `engines` says (`mn grant` needs 22.18 or newer, and says so).
- Every package's tarball carries the Apache-2.0 `LICENSE` (a copy in each package's folder), and each `@kuiralabs` package declares `publishConfig.access: public`.
- `midnight`, `mn`, and `midnight-wallet-mcp` are registered as CLI commands via `bin`.
- The sidecar is an `optionalDependency`: a platform we don't build for, or a skipped install, cleanly falls back to the WASM dust reader — the CLI still works, just slower on a cold dust prime.
- No install/lifecycle scripts anywhere, so npm v12's script-blocking defaults don't affect installs.
