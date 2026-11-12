// @kuiralabs/midnight-engine-rc: the engine, loaded once the install is known to
// be the tree it was tested with. That is checked before any SDK module loads,
// against the npm-shrinkwrap.json the package ships: an installer that ignores
// it (bun's) resolves the ranges again, and the SDK can then fail as it loads,
// before any check inside the engine could say why.

// Before any SDK module: Node 22's WebSocket made to fire close on a failed connect.
import './websocket-close.ts';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstalledAsShipped, type Engine, type EngineHost } from '@kuiralabs/midnight-cli-core/engine';
import type { RepoDeps } from './wallet-data-repository.ts';

assertInstalledAsShipped("mn's rc engine", dirname(dirname(fileURLToPath(import.meta.url))));
const engine = await import('./rc-engine.ts');

/** What an rc engine is made with besides its host. */
export interface RcEngineOptions {
  /** Its wallet repository's seams (the clock, the chain's and the indexer's reads), for a test standing in for the network. */
  readonly repository?: RepoDeps;
}

/** The rc engine, for a host's engine loader. */
export function createRcEngine(host: EngineHost, options: RcEngineOptions = {}): Engine {
  return engine.createRcEngine(host, options);
}
