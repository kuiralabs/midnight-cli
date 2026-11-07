# Publishing midnight-wallet-cli

Releases are **tag-triggered**. Pushing a `v*` tag runs `.github/workflows/release-sidecar.yml`, which builds the native dust-sync sidecar for every platform and publishes the per-platform packages **and** the main package. Do **not** run `npm publish` by hand — that would ship the main package without the platform binaries, leaving its `optionalDependencies` pointing at packages that were never published.

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

The main tarball ships only `dist/`, `docs/SKILL.md`, `docs/SKILL-CORE.md` and `NOTICE` (see `files` in `package.json`). Anything else the code reads at run time has to be added there: `node scripts/fresh-install-check.mjs` installs the packed tarball into an empty directory and checks it, MCP resources included. The native binaries live in the separate `@kuiralabs/dust-sync-*` packages, not this tarball.

## Cut a release

1. Bump the version in `package.json`, and the @kuiralabs workspace packages' version (`0.1.0-rc.N`) in every `packages/*/package.json`, the five `packages/dust-sync-*` platform packages included. The release workflow pins mn's `optionalDependencies` to the platform packages' version (exactly) with `node scripts/sync-sidecar-versions.mjs`; run it by hand only to check, and don't commit what it writes, since `npm ci` can't install a platform package before it is published.
2. Update `CHANGELOG.md` (dated section), commit, and push `main`.
3. Tag and push:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
4. The `release` workflow first checks that the tag (without the leading `v`) equals `package.json`'s `version`, and fails before publishing anything if they differ. Then, on native runners per platform:
   - builds `dust-sync` with `cargo build --release --locked` (the `--locked` keeps the `midnight-ledger-v9 =1.0.0` pins so the serialized `DustLocalState` round-trips byte-identically with the rc engine's `@midnightntwrk/ledger-v9`), runs its tests and checks that `dust-sync --ledger` prints `9` where the runner can run the binary (all but darwin-x64, which is cross-compiled);
   - publishes the five `@kuiralabs/dust-sync-<os>-<arch>` packages **before** the main package (so its optional deps resolve), unless that version is on npm already; an `-rc` version goes to the `next` dist-tag;
   - publishes `midnight-wallet-cli`.

**Prereleases.** A tag with a prerelease suffix (e.g. `v0.6.0-rc.0`) publishes everything, the platform packages included, under the npm `next` dist-tag, so it never becomes `latest`. Bump `package.json` to the same prerelease version before tagging; the tag check above applies here too.

Dry-run the build without publishing via the workflow's `workflow_dispatch` (`dry_run: true`) — it builds all five targets and skips the publish job.

## Auth: OIDC trusted publishing

Publishing uses **OIDC trusted publishing** (no long-lived secret) once each of the six packages has a trusted publisher configured on npmjs.com (repo `kuiralabs/midnight-cli`, workflow `release-sidecar.yml`).

**First release bootstrap** — a trusted publisher can only be attached to a package that already exists, so the very first publish needs a one-time classic **Automation** token stored as the `NPM_TOKEN` repo secret. After that release, configure the six trusted publishers and the secret can be deleted; every later tag publishes tokenless. The five `@kuiralabs/dust-sync-*` platform packages are new names on npm (they were `@nel349/dust-sync-*` up to 0.5.x), so their first publish needs that token too, and a trusted publisher each afterwards.

## Notes

- `bun build --packages external` keeps runtime deps as imports (resolved via `node_modules`); consumers only need Node.js (>= 20).
- `midnight`, `mn`, and `midnight-wallet-mcp` are registered as CLI commands via `bin`.
- The sidecar is an `optionalDependency`: a platform we don't build for, or a skipped install, cleanly falls back to the WASM dust reader — the CLI still works, just slower on a cold dust prime.
- No install/lifecycle scripts anywhere, so npm v12's script-blocking defaults don't affect installs.
