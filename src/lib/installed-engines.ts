// A shell concern: the SDK engines this build of mn ships, which the host
// makes its engine with (its engine loader). Each loads its SDK, so each is
// imported only when a call needs it.

import type { Engine, SdkSet } from '@kuiralabs/midnight-cli-core/lib/engine';
import type { Host } from '@kuiralabs/midnight-cli-core/lib/host';

/** The engine for an SDK set, as this build ships it, made for `host`. */
export async function loadInstalledEngine(set: SdkSet, host: Host): Promise<Engine> {
  switch (set) {
    case 'rc':
      return (await import('@kuiralabs/midnight-engine-rc')).createRcEngine(host);
    case 'beta':
      return (await import('@kuiralabs/midnight-engine-beta')).createBetaEngine(host);
  }
}
