// The host: what a program gives the libraries it runs. Its settings, its
// paths (the state root and the user's home), where its notices go, who
// answers its questions, its SDK engine, where the SDK's warnings go, and the
// state the libraries keep for it (the slots). A program creates one and
// passes it in; two hosts in one process share nothing of it but the SDK set
// the process runs (two sets' ledgers can't share a process).
//
// mn's shell builds one at start, its MCP server one for all its calls.

import type { HostPaths } from './state-root.ts';
import { NoStateRootError } from './state-root.ts';
import { settingsFromEnvironment, type Settings } from './settings.ts';
import type { Prompter } from './prompter.ts';
import { createSdkWarningRouter, sdkWarningCallsOn, type SdkWarningCalls } from './sdk-warnings.ts';
import { claimSdkSet, OtherSdkSetError, sdkSetOf, type Engine, type EngineLoader, type HostEngines, type SdkSet } from './engine.ts';
import type { NetworkName } from './network.ts';

/** A piece of state a library keeps per host, named by the library that owns it. */
export interface HostSlot<T> {
  readonly name: string;
  readonly init: () => T;
}

/** Names a piece of per-host state; `init` makes a host's first value. */
export function defineHostSlot<T>(name: string, init: () => T): HostSlot<T> {
  return Object.freeze({ name, init });
}

export interface Host {
  /** The settings now. */
  settings(): Settings;
  /** The state root and the user's home. Throws NoStateRootError when the host gave none. */
  paths(): HostPaths;
  /** One line for the person, already formatted; dropped when the host takes none. */
  notice(line: string): void;
  /** Who answers questions (a passphrase, an approval); null when nobody can. */
  readonly prompter: Prompter | null;
  /** Where the SDK's warnings go, per call. */
  readonly sdkWarnings: SdkWarningCalls;
  /** This host's SDK engine, made by its engine loader on first use. */
  readonly engines: HostEngines;
  /** This host's value of a library's state, made on first use. */
  slot<T>(key: HostSlot<T>): T;
}

/** A value, or a function giving the value now. */
export type Supplied<T> = T | (() => T);

export interface HostOptions {
  /** The state root and the user's home; without them, anything that keeps state refuses (NoStateRootError). */
  readonly paths?: Supplied<HostPaths>;
  /** The settings; every one unset when not given. */
  readonly settings?: Supplied<Settings>;
  /** Where notices go; dropped when not given. */
  readonly notice?: (line: string) => void;
  /** Who answers questions; nobody when not given. */
  readonly prompter?: Prompter | null;
  /** Where the SDK's warnings go; a router of the host's own when not given. */
  readonly sdkWarnings?: SdkWarningCalls;
  /** Makes this host's engine for an SDK set; without one, asking for an engine refuses. */
  readonly engineLoader?: EngineLoader;
}

const UNSET: Settings = settingsFromEnvironment({});

const read = <T>(supplied: Supplied<T>): T => (typeof supplied === 'function' ? (supplied as () => T)() : supplied);

export function createHost(options: HostOptions = {}): Host {
  const slots = new Map<HostSlot<unknown>, unknown>();
  const { paths, settings, notice, prompter = null } = options;
  const sdkWarnings = options.sdkWarnings ?? sdkWarningCallsOn(createSdkWarningRouter());
  const host: Host = {
    settings: () => (settings === undefined ? UNSET : read(settings)),
    paths: () => {
      if (paths === undefined) throw new NoStateRootError();
      return read(paths);
    },
    notice: (line) => notice?.(line),
    prompter,
    sdkWarnings,
    engines: hostEngines(() => host, options.engineLoader),
    slot<T>(key: HostSlot<T>): T {
      if (!slots.has(key)) slots.set(key, key.init());
      return slots.get(key) as T;
    },
  };
  return host;
}

/** A host's engines: the one engine its loader makes it, and the set work every set does alike prefers. */
function hostEngines(host: () => Host, loader: EngineLoader | undefined): HostEngines {
  let loaded: Promise<Engine> | undefined;
  let preferred: SdkSet | undefined;
  const root = () => host().paths().stateRoot;
  const load = async (set: SdkSet): Promise<Engine> => {
    if (loaded === undefined) {
      if (loader === undefined) throw new Error('No SDK engine is installed: the host is given an engine loader (createHost\'s engineLoader)');
      claimSdkSet(set);
      loaded = loader(set, host());
    }
    const engine = await loaded;
    if (engine.set !== set) throw new OtherSdkSetError(engine.set, set);
    return engine;
  };
  return {
    load,
    for: async (network: NetworkName) => load(sdkSetOf(network, root())),
    any: () => loaded ?? load(preferred ?? 'rc'),
    prefer: (network: NetworkName) => { preferred = sdkSetOf(network, root()); },
  };
}
