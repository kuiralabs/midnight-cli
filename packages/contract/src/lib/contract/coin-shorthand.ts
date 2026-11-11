// A fresh shielded coin as a circuit argument, written the way a person
// thinks of it. A circuit that takes a coin (`lock(coin: ShieldedCoinInfo)`,
// then `receiveShielded(coin)`) is given a NEW coin the transaction creates for
// the contract, which the wallet pays for from its own coins: its nonce must be
// fresh and random, its colour the token's raw type, its value in the token's
// smallest unit. Written by hand that is 32 random bytes, 32 zero bytes and
// "3000000n"; here it is
//
//   {"@coin": {"amount": "3", "token": "NIGHT"}}
//
// which mn expands before the call, in its own process. "@" can't begin a
// Compact identifier, so no struct field is ever called "@coin" and the
// shorthand can't be mistaken for a real argument. It stands only where the
// circuit takes a ShieldedCoinInfo.
//
// No error here quotes the amount or the token: they are the coin's private
// values.

import { randomBytes } from 'node:crypto';
import { UsageError } from '@kuiralabs/midnight-cli-core';
import type { CompactType } from './inspect.ts';
import { isShieldedCoinInfo } from './held-coins.ts';

/** The key that marks a fresh-coin shorthand. */
export const COIN_SHORTHAND_KEY = '@coin';

/** The token name for NIGHT, whose shielded raw type is 32 zero bytes. */
const NIGHT = 'NIGHT';
const NIGHT_DECIMALS = 6;
/** A coin's value is a 64-bit integer on the ledger. */
const MAX_COIN_VALUE = 2n ** 64n - 1n;

/** A fresh coin mn made for an argument: where it is, and its nonce (hex), which a contract may name it by later. */
export interface FreshCoin {
  /** The argument it is: `coin`, or `bet.coin` for a struct's field, `coins[1]` for a vector's item. */
  argument: string;
  nonce: string;
}

/** The arguments with every shorthand expanded, and the fresh coins made for them, in order. */
export interface ExpandedArgs {
  args: unknown[];
  freshCoins: FreshCoin[];
}

/** A typed argument: what contract-info.json says of a circuit's argument. */
export interface TypedArgument {
  name: string;
  type: CompactType;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Whether `value` is a fresh-coin shorthand (`{"@coin": ...}`). */
export function isCoinShorthand(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.hasOwn(value, COIN_SHORTHAND_KEY);
}

/** Whether any shorthand is anywhere in `value`. */
export function hasCoinShorthand(value: unknown): boolean {
  if (isCoinShorthand(value)) return true;
  if (Array.isArray(value)) return value.some(hasCoinShorthand);
  if (isPlainObject(value)) return Object.values(value).some(hasCoinShorthand);
  return false;
}

/** The amount in the token's smallest unit: NIGHT as a decimal NIGHT amount, another token as a whole number of its smallest unit. */
function coinValue(amount: unknown, night: boolean, at: string): bigint {
  const text = typeof amount === 'number' && Number.isFinite(amount) ? String(amount) : amount;
  if (typeof text !== 'string') {
    throw new UsageError(`${at}: "amount" is missing or not a number. Give it as a string, e.g. {"${COIN_SHORTHAND_KEY}": {"amount": "3", "token": "NIGHT"}}.`);
  }
  let value: bigint;
  if (night) {
    const match = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
    if (match === null || (match[1] === '' && (match[2] ?? '') === '')) {
      throw new UsageError(`${at}: "amount" is not a NIGHT amount. Give a decimal number of NIGHT with at most ${NIGHT_DECIMALS} decimals, e.g. "3" or "0.5".`);
    }
    const decimals = match[2] ?? '';
    if (decimals.length > NIGHT_DECIMALS) {
      throw new UsageError(`${at}: "amount" has more than ${NIGHT_DECIMALS} decimals; NIGHT's smallest unit is 0.000001.`);
    }
    value = BigInt((match[1] || '0') + decimals.padEnd(NIGHT_DECIMALS, '0'));
  } else {
    if (!/^\d+$/.test(text.trim())) {
      throw new UsageError(`${at}: "amount" of a token given by its raw type is a whole number of its smallest unit (mn doesn't know its decimals), e.g. "3000000".`);
    }
    value = BigInt(text.trim());
  }
  if (value > MAX_COIN_VALUE) throw new UsageError(`${at}: "amount" is more than a coin can hold (2^64 - 1 of the token's smallest unit).`);
  if (value === 0n) throw new UsageError(`${at}: "amount" must be more than 0.`);
  return value;
}

/** The token's raw type as 32 bytes: NIGHT's (zeros), or 64 hex characters as given. */
function coinColor(token: unknown, at: string): { color: number[]; night: boolean } {
  if (token === undefined || (typeof token === 'string' && token.toUpperCase() === NIGHT)) return { color: new Array<number>(32).fill(0), night: true };
  const hex = typeof token === 'string' ? token.replace(/^0x/i, '') : '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new UsageError(`${at}: "token" is "${NIGHT}" or a token's raw type as 64 hex characters (32 bytes).`);
  }
  return { color: [...Buffer.from(hex, 'hex')], night: false };
}

/** A fresh coin for the shorthand `value` at `at`: a random nonce, the token's colour and the amount, as the circuit takes them in JSON. */
function freshCoinOf(value: Record<string, unknown>, at: string, random: (size: number) => Uint8Array): { coin: Record<string, unknown>; nonce: string } {
  const extra = Object.keys(value).filter((key) => key !== COIN_SHORTHAND_KEY);
  if (extra.length > 0) throw new UsageError(`${at}: a "${COIN_SHORTHAND_KEY}" object has no other keys (found ${extra.map((key) => `"${key}"`).join(', ')}).`);
  const spec = value[COIN_SHORTHAND_KEY];
  if (!isPlainObject(spec)) throw new UsageError(`${at}: "${COIN_SHORTHAND_KEY}" takes an object: {"amount": "<amount>", "token": "NIGHT"}.`);
  const unknown = Object.keys(spec).filter((key) => key !== 'amount' && key !== 'token');
  if (unknown.length > 0) throw new UsageError(`${at}: "${COIN_SHORTHAND_KEY}" takes "amount" and "token" only (found ${unknown.map((key) => `"${key}"`).join(', ')}).`);
  const { color, night } = coinColor(spec.token, at);
  const amount = coinValue(spec.amount, night, at);
  const nonce = random(32);
  return { coin: { nonce: [...nonce], color, value: `${amount}n` }, nonce: Buffer.from(nonce).toString('hex') };
}

/** What a type is called in a refusal. */
function typeName(type: CompactType | undefined): string {
  if (type === undefined) return 'of a type mn does not know';
  return type['type-name'] === 'Struct' && type.name !== undefined ? `a ${type.name}` : `a ${type['type-name']}`;
}

/**
 * `args` with every `{"@coin": {...}}` replaced by a fresh coin, checked
 * against the types the circuit gives its arguments (`types`, in order); each
 * must stand where a ShieldedCoinInfo goes. With no types (a constructor's,
 * which contract-info.json doesn't give), a shorthand is refused. `random`
 * gives the nonce's bytes.
 */
export function expandCoinShorthands(args: readonly unknown[], types: readonly TypedArgument[] | undefined, random: (size: number) => Uint8Array = randomBytes): ExpandedArgs {
  const freshCoins: FreshCoin[] = [];
  const expand = (value: unknown, type: CompactType | undefined, at: string): unknown => {
    if (isCoinShorthand(value)) {
      if (types === undefined) {
        throw new UsageError(`${at}: "${COIN_SHORTHAND_KEY}" stands for a circuit argument of type ShieldedCoinInfo; a constructor's argument types aren't in contract-info.json, so mn can't check it there. Give the coin as {"nonce": [...], "color": [...], "value": "<n>n"}.`);
      }
      if (!isShieldedCoinInfo(type)) {
        throw new UsageError(`${at}: "${COIN_SHORTHAND_KEY}" stands only where the circuit takes a ShieldedCoinInfo, and ${at} is ${typeName(type)}.`);
      }
      const { coin, nonce } = freshCoinOf(value, at, random);
      freshCoins.push({ argument: at, nonce });
      return coin;
    }
    if (Array.isArray(value)) {
      return value.map((item, i) => expand(item, type?.['type-name'] === 'Vector' ? type.type : type?.['type-name'] === 'Tuple' ? type.types?.[i] : undefined, `${at}[${i}]`));
    }
    if (isPlainObject(value)) {
      const fields = type?.['type-name'] === 'Struct' ? type.elements : undefined;
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, expand(field, fields?.find((element) => element.name === key)?.type, `${at}.${key}`)]));
    }
    return value;
  };
  const expanded = args.map((arg, i) => expand(arg, types?.[i]?.type, types?.[i]?.name ?? `argument ${i + 1}`));
  return { args: expanded, freshCoins };
}
