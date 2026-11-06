// Lines a library has for the person at the terminal (a plain-text wallet's
// warning, a connector's progress) go to the notices its caller gives (the
// host's: host.notice) instead of to stderr. The shell and the MCP server send
// them to stderr; a consumer sends them wherever it likes. The library never
// writes to the terminal itself.

/** Where a library's lines for the person go: one line, already formatted. */
export type NoticeSink = (line: string) => void;
