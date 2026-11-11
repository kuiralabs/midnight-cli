// A circuit's arguments are private inputs to its proof, so no failure mn
// reports carries one. The compact runtime's type error quotes the value it
// refused ("expected value of type Bytes<32> but received Uint8Array(31)
// [...]"): that value is left out, the type it wanted kept.
//
// Serialized into the generated script (runner.ts), so it uses no name of
// this module and imports nothing.

/** `message` with any argument value the compact runtime quoted in it left out. */
export function redactArgumentValues(message: string): string {
  return message.replace(/(expected value of type [^\n]*?) but received [\s\S]*$/, '$1 (the value given is not shown: circuit arguments stay private)');
}
