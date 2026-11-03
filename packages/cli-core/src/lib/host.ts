// The host: what a program gives the libraries it runs. Its settings, its
// paths (the state root and the user's home), where its notices go, who
// answers its questions, where the SDK's warnings go, and the state the
// libraries keep for it (the slots). A program creates one and passes it in;
// two hosts in one process share nothing of it.
//
// mn's shell builds one at start, its MCP server one for all its calls.

import type { HostPaths } from './state-root.ts';
import { NoStateRootError } from './state-root.ts';
import { settingsFromEnvironment, type Settings } from './settings.ts';
import type { Prompter } from './prompter.ts';
import { createSdkWarningRouter, sdkWarningCallsOn, type SdkWarningCalls } from './sdk-warnings.ts';

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
}

const UNSET: Settings = settingsFromEnvironment({});

const read = <T>(supplied: Supplied<T>): T => (typeof supplied === 'function' ? (supplied as () => T)() : supplied);

export function createHost(options: HostOptions = {}): Host {
  const slots = new Map<HostSlot<unknown>, unknown>();
  const { paths, settings, notice, prompter = null } = options;
  const sdkWarnings = options.sdkWarnings ?? sdkWarningCallsOn(createSdkWarningRouter());
  return {
    settings: () => (settings === undefined ? UNSET : read(settings)),
    paths: () => {
      if (paths === undefined) throw new NoStateRootError();
      return read(paths);
    },
    notice: (line) => notice?.(line),
    prompter,
    sdkWarnings,
    slot<T>(key: HostSlot<T>): T {
      if (!slots.has(key)) slots.set(key, key.init());
      return slots.get(key) as T;
    },
  };
}
