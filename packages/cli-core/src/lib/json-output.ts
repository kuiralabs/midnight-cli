// JSON output utilities for --json mode
// Structured JSON result/error output to stdout. Under --json stderr stays
// quiet: commands show no spinner or heading, and the CLI gives a --json call
// an output whose stderr writes nothing (the shell, not this module). The
// process's stderr stream itself is never patched: an earlier version that
// monkey-patched process.stderr.write broke Node's write() callback contract
// (libraries awaiting writes could hang).

/**
 * Write a structured JSON result to stdout: the CLI's way to write a call's
 * result (its context's output). Always outputs a single line of JSON
 * followed by a newline. The MCP server keeps each call's result in that
 * call's context instead, so nothing here is shared between calls.
 */
export function writeJsonResult(data: Readonly<Record<string, unknown>>): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

/**
 * Write a structured JSON error to stdout.
 * Format: { "error": true, "code": "ERROR_CODE", "message": "..." }
 */
export function writeJsonError(err: Error, errorCode: string, exitCode: number): void {
  const json = JSON.stringify({
    error: true,
    code: errorCode,
    message: err.message,
    exitCode,
  }) + '\n';
  process.stdout.write(json);
}
