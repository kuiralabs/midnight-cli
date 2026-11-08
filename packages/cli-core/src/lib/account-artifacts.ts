// Where mn grant gets the account contract's proving artefacts (its keys and
// ZKIR, fetched into a cache as a command first needs each): the build's
// release by default, or a source the user names, a local build of the
// contract for one whose release is not published. MN_ACCOUNT_ARTIFACTS wins
// over the config key `account-artifacts`. Not per network: it is the account
// build's. The account package checks every file it takes from a source
// against the build's manifest, so a wrong source is refused, never used.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ACCOUNT_ARTIFACTS_ENV, type Settings } from './settings.ts';
import type { CliConfig } from './cli-config.ts';
import { UsageError } from './errors.ts';

/** The config key. */
export const ACCOUNT_ARTIFACTS_KEY = 'account-artifacts';

/** A source of the account contract's proving artefacts that is not one: not an http(s) URL, or not a build folder. */
export class InvalidAccountArtifactsSourceError extends UsageError {
  /** The source as given, and where it was given (the variable or the config key). */
  readonly source: string;
  readonly origin: string;

  constructor(source: string, origin: string, reason: string) {
    super(
      `The account contract's proving artefacts can't be had from ${JSON.stringify(source)} (${origin}): ${reason}.\n`
      + `Give an http(s) URL laid out as a release, or the absolute path of a build of the account contract (the folder holding keys/ and zkir/): midnight config set ${ACCOUNT_ARTIFACTS_KEY} <folder or URL>, or ${ACCOUNT_ARTIFACTS_ENV}.`,
    );
    this.name = 'InvalidAccountArtifactsSourceError';
    this.source = source;
    this.origin = origin;
    Object.setPrototypeOf(this, InvalidAccountArtifactsSourceError.prototype);
  }
}

/**
 * `value` as a source of the account contract's proving artefacts: an http(s)
 * URL as it is, or the absolute path (a file: URL read as one) of a folder that
 * holds keys/. Throws InvalidAccountArtifactsSourceError naming `origin` for
 * anything else.
 */
export function checkAccountArtifactsSource(value: string, origin: string): string {
  const source = value.trim();
  if (/^https?:\/\/\S+$/.test(source)) {
    try {
      new URL(source);
      return source;
    } catch {
      throw new InvalidAccountArtifactsSourceError(value, origin, 'it is not a URL');
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !source.startsWith('file://')) {
    throw new InvalidAccountArtifactsSourceError(value, origin, 'a URL must be http or https');
  }
  const folder = source.startsWith('file://') ? fileURLToPath(source) : source;
  if (!path.isAbsolute(folder)) throw new InvalidAccountArtifactsSourceError(value, origin, 'a folder must be given by its absolute path');
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new InvalidAccountArtifactsSourceError(value, origin, 'there is no folder there');
  if (!fs.existsSync(path.join(folder, 'keys'))) throw new InvalidAccountArtifactsSourceError(value, origin, 'it has no keys/ folder, so it is not a build of the account contract');
  return folder;
}

/** Where the artefacts come from, and who said so; `source` undefined for the build's release. */
export interface AccountArtifactsSource {
  source: string | undefined;
  /** MN_ACCOUNT_ARTIFACTS, the config key, or the build's release. */
  origin: string;
}

/** The source the settings and mn's `config` give: MN_ACCOUNT_ARTIFACTS, else the config key, else the build's release. */
export function resolveAccountArtifactsSource(settings: Pick<Settings, 'accountArtifacts'>, config: Pick<CliConfig, 'account-artifacts'>): AccountArtifactsSource {
  const fromEnvironment = settings.accountArtifacts?.trim();
  if (fromEnvironment) return { source: checkAccountArtifactsSource(fromEnvironment, ACCOUNT_ARTIFACTS_ENV), origin: ACCOUNT_ARTIFACTS_ENV };
  const fromConfig = config[ACCOUNT_ARTIFACTS_KEY];
  if (fromConfig !== undefined) return { source: checkAccountArtifactsSource(fromConfig, `config key ${ACCOUNT_ARTIFACTS_KEY}`), origin: `config key ${ACCOUNT_ARTIFACTS_KEY}` };
  return { source: undefined, origin: "the account build's release" };
}
