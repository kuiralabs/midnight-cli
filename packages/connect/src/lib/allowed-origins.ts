// The browser origins mn serve lets connect. A browser sends an Origin header
// on every WebSocket connection, naming the page that opened it; a Node
// script sends none. mn serve refuses every origin it was not told to allow,
// so a web page the user happens to open cannot read or spend from the wallet.

import { UsageError } from '@kuiralabs/midnight-cli-core';

/**
 * The origin a browser sends for a page at `input`, as `--allow-origin`
 * takes it: `http` or `https`, a host and an optional port, with no path,
 * query or fragment (`http://localhost:5173`). Throws a UsageError naming the
 * value and the form it must take otherwise.
 */
export function parseAllowedOrigin(input: string): string {
  const example = 'e.g. --allow-origin http://localhost:5173';
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UsageError(`--allow-origin "${input}" is not an origin: give the scheme, host and port of the dApp's page, ${example}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`--allow-origin "${input}" is not an http or https origin: give the origin the dApp's page is served from, ${example}`);
  }
  if (url.username !== '' || url.password !== '' || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '' || /[?#]/.test(input)) {
    throw new UsageError(`--allow-origin "${input}" has more than an origin: give only the scheme, host and port (${url.origin}), ${example}`);
  }
  return url.origin;
}

/** The origins `inputs` name, each as parseAllowedOrigin reads it, without repeats. */
export function parseAllowedOrigins(inputs: readonly string[]): string[] {
  return [...new Set(inputs.map(parseAllowedOrigin))];
}

/** The origin a browser sends for a page served at `pageUrl` (its scheme, host and port). */
export function originOfPage(pageUrl: string): string {
  return new URL(pageUrl).origin;
}
