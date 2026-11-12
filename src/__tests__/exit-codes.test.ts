import { describe, it, expect } from 'vitest';
import { classifyError, humanizeNetworkError, ERROR_CODES, EXIT_GENERAL_ERROR, EXIT_NETWORK_ERROR, EXIT_INVALID_ARGS, WrongPassphraseError, UsageError } from '@kuiralabs/midnight-cli-core';
import { MixedSdkLayoutError, toEngineError } from '@kuiralabs/midnight-cli-core/engine';
import { NoAccountError, NodeTooOldForAccountError, UnreachableByAccountError } from '@kuiralabs/midnight-grant';
import { NoPassphraseError } from '@kuiralabs/midnight-wallet';
import { installedCommands } from '../lib/installed-commands.ts';

describe('humanizeNetworkError', () => {
  it('rewrites the empty-reason node-fetch tail with URL + cause hint', () => {
    const original = 'request to http://localhost:8088/api/v4/graphql failed, reason:';
    const out = humanizeNetworkError(original);
    expect(out).toContain('http://localhost:8088/api/v4/graphql');
    expect(out).toContain('connection refused');
    expect(out).toContain('Is the indexer running?');
    expect(out).not.toMatch(/reason:\s*$/);
  });

  it('leaves messages with a real reason untouched', () => {
    const original = 'request to https://api.example.com failed, reason: ECONNREFUSED 127.0.0.1:443';
    expect(humanizeNetworkError(original)).toBe(original);
  });

  it('leaves unrelated messages untouched', () => {
    expect(humanizeNetworkError('Wallet has 0 NIGHT')).toBe('Wallet has 0 NIGHT');
    expect(humanizeNetworkError('')).toBe('');
  });
});

describe('classifyError network coverage', () => {
  it('classifies the empty-reason node-fetch error, read at the engine boundary, as NETWORK_ERROR', () => {
    const err = toEngineError(new Error('request to http://localhost:8088/api/v4/graphql failed, reason:')) as Error;
    const { exitCode, errorCode } = classifyError(err, installedCommands);
    expect(exitCode).toBe(EXIT_NETWORK_ERROR);
    expect(errorCode).toBe(ERROR_CODES.NETWORK_ERROR);
  });
});

describe('classifyError usage errors (positional-address balance)', () => {
  // The balance command throws these as UsageErrors (error-code-parity.test.ts
  // runs it); approved (Y52), their words alone no longer give INVALID_ARGS.
  const PRIVATE = 'Shielded balances are private — they can only be read with the wallet\'s secret key, not from an address alone.\n' +
    'This address isn\'t one of your wallets. Check its shielded balance from the wallet that owns it:\n' +
    '  midnight balance --wallet <name> --network undeployed';
  const MISMATCH = 'Address belongs to undeployed but --network is preprod.\nDrop --network or pass an address for preprod.';

  it.each([['the "shielded balances are private" error', PRIVATE], ['the address-HRP / --network mismatch', MISMATCH]])('classifies %s by its class: INVALID_ARGS as a UsageError, UNKNOWN as a plain error', (_what, said) => {
    expect(classifyError(new UsageError(said), installedCommands)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.INVALID_ARGS });
    expect(classifyError(new Error(said), installedCommands)).toEqual({ exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.UNKNOWN });
  });
});

describe('classifyError: typed setup errors keep their own code', () => {
  // Agents read errorCode from --json / MCP; these must not collapse to UNKNOWN.
  it.each([
    ['UNSUPPORTED_LEDGER', async () => new (await import('@kuiralabs/midnight-chain')).UnsupportedLedgerError('preview', 1000300n)],
    ['LOCAL_STACK_UNREACHABLE', async () => new (await import('@kuiralabs/midnight-chain')).LocalStackUnreachableError('indexer', 'http://localhost:8088/api/v4/graphql')],
    ['AMBIGUOUS_LOCAL_STACKS', async () => new (await import('@kuiralabs/midnight-cli-core')).AmbiguousLocalStacksError({ node: [9944, 29944], indexer: [8088, 28088], proofServer: [6300] })],
  ])('%s', async (code, make) => {
    const result = classifyError(await make(), installedCommands);
    expect(result.errorCode).toBe(code);
    expect(result.errorCode).toBe(ERROR_CODES[code as keyof typeof ERROR_CODES]);
    expect(result.exitCode).toBe(EXIT_NETWORK_ERROR);
  });

  it('ignores a code that is not a known setup code', () => {
    const err = Object.assign(new Error('something odd'), { code: 'ENOENT' });
    expect(classifyError(err, installedCommands).errorCode).toBe(ERROR_CODES.UNKNOWN);
  });
});

describe('classifyError: mn grant', () => {
  it('gives a wallet with no account its own code, so a caller can deploy one', () => {
    expect(classifyError(new NoAccountError('alice', 'undeployed'), installedCommands)).toEqual({ exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.NO_ACCOUNT });
  });

  it('counts a network the account package can\'t reach as the caller\'s to fix', () => {
    expect(classifyError(new UnreachableByAccountError('PreProd'), installedCommands)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.INVALID_ARGS });
  });

  it('names an install that mixes the engine\'s SDK copies', () => {
    expect(classifyError(new MixedSdkLayoutError("mn's rc engine", '@midnightntwrk/ledger-v9', ['/a', '/b']), installedCommands)).toEqual({ exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.MIXED_SDK_LAYOUT });
  });

  it('says a Node.js too old for the account package is an unsupported Node.js', () => {
    expect(classifyError(new NodeTooOldForAccountError('22.10.0'), installedCommands)).toEqual({ exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.UNSUPPORTED_NODE });
  });

  it("names a wrong passphrase, and a missing one, as the caller's to fix", () => {
    expect(classifyError(new WrongPassphraseError(), installedCommands)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.WRONG_PASSPHRASE });
    expect(classifyError(new NoPassphraseError(), installedCommands)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.PASSPHRASE_REQUIRED });
  });
});

describe('classifyError: usage errors', () => {
  it('classifies any UsageError as INVALID_ARGS (exit 2), whatever its text, so MCP agents get INVALID_ARGS too', async () => {
    expect(classifyError(new UsageError('A contract address is 64 hex characters (32 bytes); got "deadbeef" (8 characters).'), installedCommands))
      .toEqual({ exitCode: 2, errorCode: 'INVALID_ARGS' });
    expect(classifyError(new UsageError('increment takes 0 arguments; --args gave 3.'), installedCommands))
      .toEqual({ exitCode: 2, errorCode: 'INVALID_ARGS' });
  });
});
