// A shell concern: the SDK engine this build of mn ships, which the host
// makes its engine with (its engine loader). It loads its SDK, so it is
// imported only when a call needs it.

import type { Engine, SdkSet, Host } from '@kuiralabs/midnight-cli-core';

/** The engine for an SDK set, as this build ships it, made for `host`. */
export async function loadInstalledEngine(_set: SdkSet, host: Host): Promise<Engine> {
  return (await import('@kuiralabs/midnight-engine-rc')).createRcEngine(host);
}
