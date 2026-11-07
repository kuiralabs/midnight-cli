// Midnight Wallet CLI — MCP Server
// Exposes the installed commands' MCP tools via stdio transport
// Launch: midnight-wallet-mcp (or: node dist/mcp-server.js)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolRequest,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type ProgressToken,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { servePayer } from '@kuiralabs/midnight-connect';
import { classifyError, asReported, trimAgentMessage, needsConfirmation, type CommandRun, type Host, UsageError } from '@kuiralabs/midnight-cli-core';
import { withServerAdvice } from './lib/mcp/server-advice.ts';
import { PKG_VERSION } from './lib/pkg.ts';
import { createConfirmationStore } from './lib/mcp/confirmation.ts';
import { assertKnownParams, assertParamTypes } from './lib/mcp/known-params.ts';
import { CONFIRM_TOOL, confirmationFor, findTool, listedTools, pinConfirmedTarget, runTool } from './lib/mcp/registry-tools.ts';
import { ensureHeapForSync } from './lib/heap-guard.ts';
import { assertNodeSupported } from './lib/node-version.ts';
import { hideProjectIdsInOutput } from './lib/output-redaction.ts';
import { createCliHost } from './lib/cli-host.ts';
import { installedCommands } from './lib/installed-commands.ts';
import { skillCore, skillFull } from './lib/mcp/skills.ts';

// Skill resources — teach MCP clients how to use this CLI conversationally.
// Split into:
//   - /core: intent routing + safety rules. ~830 tokens. Fetch on session start.
//   - /full: canonical flows, error recovery, concept primers. ~2.3k tokens.
//           Fetch on demand (errors, multi-step flows, concept questions).
// The original `midnight-wallet://skill` URI stays as a deprecated alias for
// /full so existing MCP clients keep working. Both are assembled from the
// installed packages' guidance at each read.
const SKILL_CORE_URI = 'midnight-wallet://skill/core';
const SKILL_FULL_URI = 'midnight-wallet://skill/full';
const SKILL_LEGACY_URI = 'midnight-wallet://skill';

const confirmationStore = createConfirmationStore();

// The client is gone once the server's stdin closes: no answer can reach it.
// Every call still running is cancelled, and the server exits once they have
// stopped, or after SHUTDOWN_GRACE_MS, whichever is first.
const SHUTDOWN_GRACE_MS = 2_000;
const clientGone = new AbortController();
const callsRunning = new Set<Promise<unknown>>();

// What the host gives the tools' runs, once main() has installed it.
let host: Host | null = null;

// ── Server setup ────────────────────────────────────────────

const server = new Server(
  { name: 'midnight-wallet-cli', version: PKG_VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

// ── Resources: skill files (core + full + deprecated alias) ───
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: SKILL_CORE_URI,
      name: 'midnight-wallet skill (core)',
      description: 'Read this first. Intent routing table + non-negotiable safety rules. ~830 tokens. Fetch /full on demand for canonical flows, error recovery, and concept primers.',
      mimeType: 'text/markdown',
    },
    {
      uri: SKILL_FULL_URI,
      name: 'midnight-wallet skill (full)',
      description: 'Canonical multi-step flows, error-recovery recipes, concept primers (NIGHT/DUST/shielded), network selection. Fetch on demand when you hit an error, start a multi-step flow, or need to explain a concept.',
      mimeType: 'text/markdown',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (uri === SKILL_CORE_URI) {
    const text = skillCore(installedCommands);
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  // Legacy `midnight-wallet://skill` aliases to /full so existing clients keep
  // working. Not advertised in resources/list — new clients should use
  // /core + /full explicitly.
  if (uri === SKILL_FULL_URI || uri === SKILL_LEGACY_URI) {
    const text = skillFull(installedCommands);
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

// List available tools: the installed commands' tools, from their definitions, then the confirm tool.
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools(installedCommands) }));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
  const running = callTool(request, extra);
  callsRunning.add(running);
  void running.finally(() => callsRunning.delete(running)).catch(() => {});
  return running;
});

async function callTool(request: CallToolRequest, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) {
  const { name, arguments: rawParams } = request.params;
  const params = (rawParams ?? {}) as Record<string, unknown>;
  const call = toolCall(request.params._meta?.progressToken, extra);

  // A parameter outside the tool's schema, or not of its type, is refused
  // before anything runs or a token is given. An unknown tool is reported by
  // executeTool.
  const tool = findTool(installedCommands, name);
  const schema = name === CONFIRM_TOOL.name ? CONFIRM_TOOL : tool;
  if (schema !== undefined) {
    try {
      assertKnownParams(schema, params);
      assertParamTypes(schema, params);
    } catch (err) {
      return errorResponse(err instanceof Error ? err : new Error(String(err)), call);
    }
  }

  // Step 2 of confirmation: redeem the token and execute the original tool.
  if (name === CONFIRM_TOOL.name) {
    const token = typeof params.token === 'string' ? params.token : '';
    const pending = confirmationStore.redeem(token);
    if (!pending) {
      return errorResponse(new UsageError('Unknown or expired confirmation token. Call the first-step tool again for a new token.'), call);
    }
    return executeTool(pending.tool, pending.args, call);
  }

  // Step 1 of confirmation: return a pending token instead of executing.
  if (tool !== undefined && needsConfirmation(tool, params)) {
    // The wallet and network the call acts as are fixed now: confirming runs as them, whatever is active then.
    let pinned: Record<string, unknown>;
    let description: string;
    try {
      pinned = pinConfirmedTarget(tool, params, call.host.paths().stateRoot);
      description = await confirmationFor(tool, pinned, call);
    } catch (err) {
      return errorResponse(err instanceof Error ? err : new Error(String(err)), call);
    }
    const pending = confirmationStore.create({ tool: name, args: pinned, description });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(stamp({
          pending: true,
          token: pending.token,
          description: pending.description,
          tool: pending.tool,
          expiresAt: new Date(pending.expiresAt).toISOString(),
          nextStep: 'Show the description to the user, get explicit consent, then call midnight_confirm_operation with this token.',
        }), null, 2),
      }],
    };
  }

  return executeTool(name, params, call);
}

/**
 * A tool call's run: it stops when the client cancels the call, and when the
 * client asked for progress (a progress token), each message the command's
 * spinners say goes to it as a progress notification. A message the same as
 * the one before is not sent again.
 */
function toolCall(progressToken: ProgressToken | undefined, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): CommandRun {
  if (host === null) throw new Error('The MCP server took a call before its host was installed');
  // Cancelled by the client, or when the client goes away.
  const signal = AbortSignal.any([extra.signal, clientGone.signal]);
  if (progressToken === undefined) return { signal, payer: servePayer, host };
  let progress = 0;
  let last: string | undefined;
  return {
    signal,
    payer: servePayer,
    host,
    onProgress: (message) => {
      if (message === last) return;
      last = message;
      progress += 1;
      // Progress is a courtesy to the client: one it fails to take must not fail the tool.
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress, message } }).catch(() => {});
    },
  };
}

/**
 * Stamp every MCP response with the server's PKG_VERSION so callers can
 * detect a stale server (CLI on disk says X, MCP responses say Y → restart
 * the MCP client). Underscore prefix marks it as metadata, distinct from
 * tool-shape data fields.
 */
function stamp<T extends Record<string, unknown>>(payload: T): T & { _serverVersion: string } {
  return { ...payload, _serverVersion: PKG_VERSION };
}

async function executeTool(name: string, params: Record<string, unknown>, call: CommandRun) {
  const tool = findTool(installedCommands, name);
  if (!tool) return errorResponse(new Error(`Unknown tool: ${name}`), call);

  try {
    const result = await runTool(tool, params, call);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(stamp(result), null, 2) }],
    };
  } catch (err) {
    return errorResponse(err instanceof Error ? err : new Error(String(err)), call);
  }
}

function errorResponse(thrown: Error, call: CommandRun) {
  // A node's refusal is reported in the node's words, also when a command wrapped it.
  const error = withServerAdvice(asReported(thrown), call.host.paths().stateRoot);
  const { errorCode } = classifyError(error, installedCommands);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(stamp({ error: true, code: errorCode, message: trimAgentMessage(error.message) })),
    }],
    isError: true,
  };
}

// Start the server
async function main() {
  // Refuse to start on a Node.js too old for the wallet SDK, where every tool would fail obscurely.
  assertNodeSupported();
  // Endpoint URLs can carry a Blockfrost project id: no response or log shows it.
  hideProjectIdsInOutput();
  // What the tools' libraries get from their host, as the CLI gives them (no prompter: no terminal here).
  host = createCliHost({ prompter: null });
  // The server runs facades on demand (balance/transfer/etc.). A cold shielded
  // sync would overflow Node's default heap, so re-exec once at startup with
  // more headroom. No-op when launched via `mn --mcp` (already bumped) or when
  // the heap is already large enough. See lib/heap-guard.ts.
  await ensureHeapForSync();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once('end', () => void shutDownForGoneClient());
  process.stdin.once('close', () => void shutDownForGoneClient());
}

/** Cancels every call still running, and exits once they have stopped or the grace has passed. */
async function shutDownForGoneClient(): Promise<void> {
  if (clientGone.signal.aborted) return;
  clientGone.abort();
  const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
  await Promise.race([Promise.allSettled([...callsRunning]), grace]);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
