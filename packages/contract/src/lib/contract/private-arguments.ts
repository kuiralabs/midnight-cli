// Which of a circuit's arguments its proof keeps private, as far as mn can
// tell from the circuit's compiled ZK IR (managed/<name>/zkir/<circuit>.zkir).
//
// Each argument enters the circuit as input wires named after it (`%coin.0`,
// `%coin.1`, ...). What the circuit makes public is its public transcript (the
// `impact` instructions, the ledger operations a node replays) and its
// outputs. An argument none of whose wires reaches those as it is stays
// private: the proof hides it (only a hash or a commitment of it, if anything,
// goes public). That is the argument `--args` would leak.
//
// A value disclosed only after arithmetic on it (`disclose(x + 1)`) is counted
// as private, so the warning can come when it isn't needed; an argument mn
// sees go public as it is never warns. No ZK IR (a contract compiled with
// --skip-zk), or one mn can't read: mn can't tell, and says nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CircuitInfo } from './inspect.ts';

/** The ZK IR mn reads: its inputs, its outputs, and its instructions' operands. */
interface Zkir {
  inputs?: { name?: unknown }[];
  outputs?: unknown[];
  instructions?: { op?: unknown; inputs?: unknown }[];
}

/**
 * The names of the arguments of `circuit` that its proof keeps private, from
 * its ZK IR in `managedDir`; undefined when mn can't tell (no ZK IR, or one
 * whose inputs don't name every argument).
 */
export function privateArgumentsOf(managedDir: string, circuit: Pick<CircuitInfo, 'name' | 'arguments'>, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): string[] | undefined {
  let zkir: Zkir;
  try {
    zkir = JSON.parse(read(join(managedDir, 'zkir', `${circuit.name}.zkir`))) as Zkir;
  } catch {
    return undefined;
  }
  if (!Array.isArray(zkir.inputs) || !Array.isArray(zkir.instructions)) return undefined;
  const inputs = zkir.inputs.map((input) => input?.name).filter((name): name is string => typeof name === 'string');
  // Every wire the public transcript or the outputs take as it is.
  const published = new Set<string>();
  const take = (operand: unknown): void => {
    if (typeof operand === 'string') published.add(operand);
    else if (Array.isArray(operand)) operand.forEach(take);
  };
  for (const instruction of zkir.instructions) {
    if (instruction?.op === 'impact') take(instruction.inputs);
  }
  take(zkir.outputs);
  const kept: string[] = [];
  for (const argument of circuit.arguments) {
    const wires = inputs.filter((name) => name.startsWith(`%${argument.name}.`) && /^\d+$/.test(name.slice(argument.name.length + 2)));
    if (wires.length === 0) return undefined;
    if (wires.some((wire) => !published.has(wire))) kept.push(argument.name);
  }
  return kept;
}
