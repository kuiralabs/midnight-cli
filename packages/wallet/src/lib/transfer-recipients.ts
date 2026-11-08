// The recipients of one transfer, as written: pairs on the command line
// (`alice 10 bob 5`) or the entries of a --to-file JSON array. Each is checked
// here for its shape alone; transfer-request resolves the names and the
// addresses.

import * as fs from 'node:fs';
import { UsageError } from '@kuiralabs/midnight-cli-core';

/** A recipient as written: a wallet name or an address, and an amount in NIGHT. */
export interface RecipientEntry {
  readonly to: string;
  /** NIGHT, as written ("2.5"). */
  readonly amount: string;
}

/**
 * The most recipients one transfer pays. The ledger counts no outputs: it caps
 * a transaction at 1 MiB (transaction_byte_limit) and a block at 50,000 bytes
 * written to the ledger state (block_limits.bytes_written), both in its
 * INITIAL_LIMITS. Each unshielded output is a UTXO written to that state and
 * each shielded one carries its own proof, so how many fit depends on the
 * coins the wallet spends and is only known once the transaction is built.
 * 50 keeps a transaction of one output per recipient well inside both, and a
 * shielded one's proving to minutes, not tens of minutes.
 */
export const MAX_TRANSFER_RECIPIENTS = 50;

const PAIRS_USAGE = 'Usage: midnight transfer <to> <amount> [<to> <amount> ...]';

/** How an entry is named in a refusal: its place and its recipient. */
export function recipientLabel(index: number, count: number, to: string): string {
  return `Recipient ${index + 1} of ${count} ("${to}")`;
}

/**
 * The recipients a transfer's words give: `<to> <amount>` pairs, in order.
 * No words, or a lone recipient, are refused as today's one-recipient
 * transfer refuses them; an odd number after that names the recipient
 * without an amount.
 */
export function recipientPairsOf(words: readonly string[]): RecipientEntry[] {
  if (words.length === 0) {
    throw new UsageError(
      'Missing recipient address.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100\n' +
      'Example: midnight transfer alice 100'
    );
  }
  if (words.length === 1) {
    throw new UsageError(
      'Missing amount.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100'
    );
  }
  if (words.length % 2 !== 0) {
    const count = (words.length + 1) / 2;
    throw new UsageError(
      `${recipientLabel(count - 1, count, words[words.length - 1]!)} has no amount: give each recipient an amount.\n` +
      PAIRS_USAGE + '\n' +
      'Example: midnight transfer alice 10 bob 5'
    );
  }
  const entries: RecipientEntry[] = [];
  for (let i = 0; i < words.length; i += 2) entries.push({ to: words[i]!, amount: words[i + 1]! });
  return entries;
}

/** Refuses no recipients, and more than MAX_TRANSFER_RECIPIENTS. */
export function assertRecipientCount(count: number): void {
  if (count === 0) {
    throw new UsageError('The transfer lists no recipients: give at least one recipient and amount.\n' + PAIRS_USAGE);
  }
  if (count > MAX_TRANSFER_RECIPIENTS) {
    throw new UsageError(
      `Too many recipients: ${count}, at most ${MAX_TRANSFER_RECIPIENTS} in one transfer.\n` +
      'Split them over several transfers.'
    );
  }
}

/**
 * The recipients a --to-file names: a JSON array of `{"to": "<wallet name or
 * address>", "amount": "<NIGHT>"}`. Refuses a file it can't read, one that
 * isn't such an array, and an empty one, each as a usage mistake.
 */
export function readRecipientsFile(file: string): RecipientEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const why = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (err as Error).message;
    throw new UsageError(`Cannot read the recipients file ${file}: ${why}.\nGive the path of a JSON file of recipients with --to-file <file>.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`The recipients file ${file} is not valid JSON: ${(err as Error).message}.\n${FILE_SHAPE}`);
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError(`The recipients file ${file} must hold a JSON array of recipients.\n${FILE_SHAPE}`);
  }
  if (parsed.length === 0) {
    throw new UsageError(`The recipients file ${file} lists no recipients.\n${FILE_SHAPE}`);
  }
  return parsed.map((entry: unknown, index) => entryOf(entry, index, parsed.length, file));
}

const FILE_SHAPE = 'Expected: [{"to": "alice", "amount": "10"}, {"to": "mn_addr_...", "amount": "2.5"}]';

function entryOf(entry: unknown, index: number, count: number, file: string): RecipientEntry {
  const where = `Entry ${index + 1} of ${count} in ${file}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new UsageError(`${where} is not an object with "to" and "amount".\n${FILE_SHAPE}`);
  }
  const { to, amount } = entry as Record<string, unknown>;
  if (typeof to !== 'string' || to.trim() === '') {
    throw new UsageError(`${where} has no "to": give a wallet name or an address.\n${FILE_SHAPE}`);
  }
  if (typeof amount !== 'string') {
    throw new UsageError(`${where} ("${to}") has ${amount === undefined ? 'no "amount"' : `"amount" ${JSON.stringify(amount)}, not a string`}: give the NIGHT as a string, such as "2.5".\n${FILE_SHAPE}`);
  }
  const unknown = Object.keys(entry).filter((key) => key !== 'to' && key !== 'amount');
  if (unknown.length > 0) {
    throw new UsageError(`${where} ("${to}") has ${unknown.map((key) => `"${key}"`).join(', ')}, which a recipient doesn't take: only "to" and "amount".`);
  }
  return { to, amount };
}
