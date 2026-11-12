// Where a deploy's or call's private-state secret comes from. It is the
// contract owner's secret (whoever has it acts as the owner), so it has ways
// in that keep it off the command line: `--secret-key-file <path>` and
// `--secret-key -` (the standard input). `--secret-key <hex>` stays, with a
// warning: on the command line it is in `ps`, the shell's history and an
// agent's transcript. `--secret-key legacy` names no secret, so it is not
// warned about.
//
// No refusal here quotes what was read.

import { resolve } from 'node:path';
import { UsageError, readInputFile } from '@kuiralabs/midnight-cli-core';
import { LEGACY_SECRET_KEY } from './private-state-secret.ts';
import type { StdinReader } from './args-input.ts';

/** The `--secret-key` value that reads the secret from the standard input. */
export const SECRET_KEY_FROM_STDIN = '-';

/** Where the secret was given: on the command line, in a file, on the standard input, or not at all. */
export type SecretKeySource = 'inline' | 'file' | 'stdin' | 'none';

/** The secret as given (trimmed of surrounding whitespace), and where it came from. */
export interface GivenSecretKey {
  secretKey?: string;
  source: SecretKeySource;
}

/** The flags the secret comes from. */
export interface SecretKeyFlags {
  secretKey?: string;
  secretKeyFile?: string;
}

/**
 * The secret `flags` give: from `--secret-key-file` (read from `cwd`; a FIFO
 * or a process substitution is read to its end), from the standard input for
 * `--secret-key -` (through `readStdin`), or `--secret-key`'s own value.
 * Refuses both flags together, a file it can't read or that holds nothing,
 * and `--secret-key -` where no standard input can be read. Whether it is
 * 32 bytes of hex is the request's check (request.ts).
 */
export function readGivenSecretKey(flags: SecretKeyFlags, cwd: string, readStdin?: StdinReader): GivenSecretKey {
  const { secretKey, secretKeyFile } = flags;
  if (secretKey !== undefined && secretKeyFile !== undefined) {
    throw new UsageError('Give the private-state secret once: --secret-key or --secret-key-file, not both.');
  }
  if (secretKeyFile !== undefined) {
    const path = resolve(cwd, secretKeyFile);
    let text: string;
    try {
      text = readInputFile(path);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      throw new UsageError(`Can't read --secret-key-file ${path}${typeof code === 'string' ? ` (${code})` : ''}: give the path of a file holding the secret, 64 hex characters.`);
    }
    return { secretKey: nonEmpty(text, `--secret-key-file ${path}`), source: 'file' };
  }
  if (secretKey === SECRET_KEY_FROM_STDIN) {
    if (readStdin === undefined) {
      throw new UsageError('--secret-key - reads the secret from the standard input, which this caller has none of (an MCP server\'s is its protocol channel). Give it with --secret-key-file <path>.');
    }
    return { secretKey: nonEmpty(readStdin(), 'the standard input (--secret-key -)'), source: 'stdin' };
  }
  if (secretKey === undefined) return { source: 'none' };
  return { secretKey, source: 'inline' };
}

/** `text` trimmed (a file or `echo` ends it with a newline), refused when nothing is left. */
function nonEmpty(text: string, from: string): string {
  const trimmed = text.trim();
  if (trimmed === '') throw new UsageError(`${from} holds no private-state secret: it needs 64 hex characters.`);
  return trimmed;
}

/**
 * A warning when the private-state secret came on the command line: there it
 * is in `ps`, the shell's history or the agent's transcript. None for
 * `legacy`, which names the wallet's public coin key, not a secret.
 */
export function inlineSecretKeyWarning(given: GivenSecretKey): string | undefined {
  if (given.source !== 'inline' || given.secretKey === LEGACY_SECRET_KEY) return undefined;
  return '--secret-key put the contract\'s private-state secret (its owner\'s secret) on the command line, where other users see it in ps and the shell keeps it in its history, or in the agent\'s transcript. Give it with --secret-key-file <path> or --secret-key - (the standard input).';
}
