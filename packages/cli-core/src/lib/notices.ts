// Lines a library has for the person at the terminal (a plain-text wallet's
// warning, a connector's progress) go here instead of to stderr. The shell
// and the MCP server send them to stderr; a consumer sends them wherever it
// likes, and with no sink they are dropped. The library never writes to the
// terminal itself.

type NoticeSink = (line: string) => void;

let sink: NoticeSink | null = null;

/** Where notices go from now on; null drops them. */
export function setNoticeSink(next: NoticeSink | null): void {
  sink = next;
}

/** One line for the person at the terminal, already formatted. */
export function notice(line: string): void {
  sink?.(line);
}
