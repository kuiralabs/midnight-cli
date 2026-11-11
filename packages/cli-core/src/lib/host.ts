// The host: what a program gives the libraries it runs. Its settings, its
// paths (the state root and the user's home), where its notices go, who
// answers its questions, its SDK engine, where the SDK's warnings go, and the
// state the libraries keep for it (the slots). A program creates one and
// passes it in; two hosts in one process share nothing of it.
//
// mn's shell builds one at start, its MCP server one for all its calls.

import type { HostPaths } from './state-root.ts';
import { NoStateRootError } from './state-root.ts';
import { settingsFromEnvironment, type Settings } from './settings.ts';
import type { Prompter } from './prompter.ts';
import { createSdkWarningRouter, sdkWarningCallsOn, type CallSdkWarnings, type SdkWarningCalls } from './sdk-warnings.ts';
import { sdkSetOf, type Engine, type EngineLoader, type HostEngines, type SdkSet } from './engine.ts';
import type { NetworkName } from './network.ts';
import type { WaitSink } from './notices.ts';

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
  /** One line for the person, already formatted; dropped when the host takes none. Also given to the call it came from, when that call collects them (collectNotices). */
  notice(line: string): void;
  /**
   * Gives the notices of the call whose SDK warnings are `call` to `collect`
   * as well, while it runs: a --json call keeps them as its warnings. The call
   * a notice comes from is the one the host's `sdkWarnings` runner says runs
   * there (the process guard knows); a notice it can't place is not collected.
   */
  collectNotices(call: CallSdkWarnings, collect: (line: string) => void): void;
  /**
   * One line of a wait the work is in (Dust for a fee): shown even where
   * notices are not (a --json run of the CLI), since minutes with nothing
   * said look like a hang. A wait's opening line, which says how long it
   * takes and why, is also given to the call it came from, as a notice is.
   */
  waiting: WaitSink;
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
  /** Where the lines of a wait go (Host.waiting); where notices go when not given. */
  readonly waiting?: (line: string) => void;
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
  const { paths, settings, notice, waiting, prompter = null } = options;
  const sdkWarnings = options.sdkWarnings ?? sdkWarningCallsOn(createSdkWarningRouter());
  // The calls that collect their notices, by their SDK warnings: gone with the call.
  const collectors = new WeakMap<CallSdkWarnings, (line: string) => void>();
  const host: Host = {
    settings: () => (settings === undefined ? UNSET : read(settings)),
    paths: () => {
      if (paths === undefined) throw new NoStateRootError();
      return read(paths);
    },
    notice: (line) => {
      const call = sdkWarnings.current?.();
      if (call !== undefined) collectors.get(call)?.(line);
      notice?.(line);
    },
    collectNotices: (call, collect) => { collectors.set(call, collect); },
    waiting: (line, opening) => {
      if (opening) {
        const call = sdkWarnings.current?.();
        if (call !== undefined) collectors.get(call)?.(line);
      }
      (waiting ?? notice)?.(line);
    },
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
      loaded = loader(set, host());
    }
    return loaded;
  };
  return {
    load,
    for: async (network: NetworkName) => load(sdkSetOf(network, root())),
    any: () => loaded ?? load(preferred ?? 'rc'),
    prefer: (network: NetworkName) => { preferred = sdkSetOf(network, root()); },
  };
}
