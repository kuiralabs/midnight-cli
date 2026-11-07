// A proving key of the account contract the account package couldn't fetch,
// told apart from any other failure of a grant command: the key, the build,
// its compiler, and whether retrying can help.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountChain } from './account-chain.ts';
import { AccountKeysUnavailableError } from './account-errors.ts';

/** The compiler version of the account build `chain` runs, from its contract-info.json; undefined when it can't be read. */
function accountCompilerVersion(chain: AccountChain): string | undefined {
  try {
    const info = JSON.parse(readFileSync(join(chain.contract.ACCOUNT_BUILD, 'compiler', 'contract-info.json'), 'utf8')) as { 'compiler-version'?: unknown };
    return typeof info['compiler-version'] === 'string' ? info['compiler-version'] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A failure to get one of the account contract's proving keys, among `err`
 * and its causes (the account package's ArtefactFetchError, as midnight-js
 * wraps it: "Failed to read verifier key for Account#…"), as an
 * AccountKeysUnavailableError naming the key and the build; undefined for any
 * other failure. Keys the build's release doesn't have (HTTP 404) are said to
 * be unpublished, which retrying can't change.
 */
export function accountKeysFailureOf(err: unknown, chain: AccountChain): AccountKeysUnavailableError | undefined {
  const seen = new Set<unknown>();
  let fetch: Error | undefined;
  for (let current: unknown = err; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current instanceof chain.errors.ArtefactFetchError) { fetch = current; break; }
  }
  if (fetch === undefined) return undefined;
  const file = /proving artefact (\S+) from /.exec(fetch.message)?.[1] ?? 'a proving key';
  const compiler = accountCompilerVersion(chain);
  const build = `account build ${chain.artefacts.ACCOUNT_BUILD_ID}${compiler === undefined ? '' : ` (compiled with compactc ${compiler})`}`;
  const unpublished = fetch.cause instanceof Error && /\bHTTP 404\b/.test(fetch.cause.message);
  return new AccountKeysUnavailableError(file, unpublished
    ? `The account contract's ${file} isn't available: the keys of this ${build} are not published (${chain.artefacts.BUILD_RELEASE} answered HTTP 404). `
      + 'mn grant needs them to deploy and to act on an account, and retrying won\'t help: use an mn release whose account build has its keys published.'
    : `The account contract's ${file} for this ${build} could not be had: ${fetch.message}`);
}
