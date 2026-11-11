// Lines a library has for the person at the terminal (a plain-text wallet's
// warning, a connector's progress) go to the notices its caller gives (the
// host's: host.notice) instead of to stderr. The shell and the MCP server send
// them to stderr; a consumer sends them wherever it likes. The library never
// writes to the terminal itself.

/** Where a library's lines for the person go: one line, already formatted. */
export type NoticeSink = (line: string) => void;

/**
 * Where the lines of a wait go (Dust for a fee): one line, already formatted;
 * `opening` marks the first line of each wait, which says how long it takes
 * and why. A wait of minutes with nothing said looks like a hang, so a host
 * shows these even where it shows no notices (mn's --json keeps stderr for
 * them alone).
 */
export type WaitSink = (line: string, opening: boolean) => void;
