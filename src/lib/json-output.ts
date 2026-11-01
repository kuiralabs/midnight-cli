// JSON output utilities for --json mode
// Structured JSON result/error output to stdout. Stderr stays untouched:
// spinners and chrome continue to flow to stderr under --json, which matches
// the UNIX convention (stdout = data, stderr = chrome/progress) and lets
// pipes like `cmd --json | jq` work without extra wiring.
//
// An earlier version monkey-patched process.stderr.write to hide chrome in
// --json mode. That violated Node's stream.write() callback contract in
// subtle ways (libraries awaiting writes could hang) and provided no real
// benefit — stderr output doesn't pollute the stdout JSON that consumers
// actually read. Simpler to not suppress stderr at all.

import { type ErrorCode } from './exit-codes.ts';

/**
 * Write a structured JSON result to stdout: the CLI's way to write a call's
 * result (its context's output, 2F). Always outputs a single line of JSON
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
export function writeJsonError(err: Error, errorCode: ErrorCode, exitCode: number): void {
  const json = JSON.stringify({
    error: true,
    code: errorCode,
    message: err.message,
    exitCode,
  }) + '\n';
  process.stdout.write(json);
}
