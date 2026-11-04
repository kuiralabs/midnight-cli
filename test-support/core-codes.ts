// Codes as a registry an error is classified through: what a test of a
// package below the shell classifies with, where the shell would use every
// installed package's codes. CORE_CODES is core's; a package adds its own.

import type { CodeDefinition, CodeRegistry } from '@kuiralabs/midnight-cli-core';
import { coreCodes } from '@kuiralabs/midnight-cli-core/commands';

/** A registry of the codes `lists` define. */
export function codeRegistry(...lists: readonly (readonly CodeDefinition[])[]): CodeRegistry {
  const codes = lists.flat();
  return { code: (code) => codes.find((definition) => definition.code === code) };
}

export const CORE_CODES = codeRegistry(coreCodes);
