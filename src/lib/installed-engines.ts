// A shell concern: the SDK engines this build of mn ships, which the host
// gives the libraries as their engine loader. Each loads its SDK, so each is
// imported only when a call needs it.

import type { Engine, SdkSet } from '@kuiralabs/midnight-cli-core/lib/engine';

/** The engine for an SDK set, as this build ships it. */
export async function loadInstalledEngine(set: SdkSet): Promise<Engine> {
  switch (set) {
    case 'rc':
      return (await import('../engine/rc/index.ts')).rcEngine;
  }
}
