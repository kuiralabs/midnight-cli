// Midnight Wallet CLI — MCP Server
// Exposes all CLI commands as MCP tools via stdio transport
// Launch: midnight-wallet-mcp (or: node dist/mcp-server.js)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type ProgressToken,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CommandRun } from './lib/run-command.ts';
import { servePayer } from './lib/serve-payer.ts';
import { classifyError } from './lib/exit-codes.ts';
import { trimAgentMessage } from './lib/error-trim.ts';
import { PKG_VERSION } from './lib/pkg.ts';
import { createConfirmationStore } from './lib/mcp/confirmation.ts';
import { assertKnownParams } from './lib/mcp/tools.ts';
import { CONFIRM_TOOL, confirmationFor, findTool, listedTools, runTool } from './lib/mcp/registry-tools.ts';
import { ensureHeapForSync } from './lib/heap-guard.ts';
import { assertNodeSupported } from './lib/node-version.ts';
import { hideProjectIdsInOutput } from './lib/output-redaction.ts';
import { installCliHost } from './lib/cli-host.ts';
import { installedCommands } from './lib/installed-commands.ts';

// Skill resources — teach MCP clients how to use this CLI conversationally.
// Split into:
//   - /core: intent routing + safety rules. ~830 tokens. Fetch on session start.
//   - /full: canonical flows, error recovery, concept primers. ~2.3k tokens.
//           Fetch on demand (errors, multi-step flows, concept questions).
// The original `midnight-wallet://skill` URI stays as a deprecated alias for
// /full so existing MCP clients keep working.
const SKILL_CORE_URI = 'midnight-wallet://skill/core';
const SKILL_FULL_URI = 'midnight-wallet://skill/full';
const SKILL_LEGACY_URI = 'midnight-wallet://skill';
const SKILL_CORE_PATH = fileURLToPath(new URL('../docs/SKILL-CORE.md', import.meta.url));
const SKILL_FULL_PATH = fileURLToPath(new URL('../docs/SKILL.md', import.meta.url));

const confirmationStore = createConfirmationStore();

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
    const text = readFileSync(SKILL_CORE_PATH, 'utf-8');
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  // Legacy `midnight-wallet://skill` aliases to /full so existing clients keep
  // working. Not advertised in resources/list — new clients should use
  // /core + /full explicitly.
  if (uri === SKILL_FULL_URI || uri === SKILL_LEGACY_URI) {
    const text = readFileSync(SKILL_FULL_PATH, 'utf-8');
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

// List available tools: the installed commands' tools, from their definitions, then the confirm tool.
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools(installedCommands) }));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: rawParams } = request.params;
  const params = (rawParams ?? {}) as Record<string, unknown>;
  const call = toolCall(request.params._meta?.progressToken, extra);

  // A parameter outside the tool's schema is refused before anything runs or
  // a token is given (Y29, 2E). An unknown tool is reported by executeTool.
  const tool = findTool(installedCommands, name);
  const schema = name === CONFIRM_TOOL.name ? CONFIRM_TOOL : tool;
  if (schema !== undefined) {
    try {
      assertKnownParams(schema, params);
    } catch (err) {
      return errorResponse(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Step 2 of confirmation: redeem the token and execute the original tool.
  if (name === CONFIRM_TOOL.name) {
    const token = typeof params.token === 'string' ? params.token : '';
    const pending = confirmationStore.redeem(token);
    if (!pending) {
      return errorResponse(new Error('Unknown or expired confirmation token. The first-step tool call may need to be re-issued.'));
    }
    return executeTool(pending.tool, pending.args, call);
  }

  // Step 1 of confirmation: return a pending token instead of executing.
  if (tool?.confirmation !== undefined) {
    let description: string;
    try {
      description = await confirmationFor(tool, params, call);
    } catch (err) {
      return errorResponse(err instanceof Error ? err : new Error(String(err)));
    }
    const pending = confirmationStore.create({ tool: name, args: params, description });
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
});

/**
 * A tool call's run: it stops when the client cancels the call, and when the
 * client asked for progress (a progress token), each message the command's
 * spinners say goes to it as a progress notification. A message the same as
 * the one before is not sent again.
 */
function toolCall(progressToken: ProgressToken | undefined, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): CommandRun {
  if (progressToken === undefined) return { signal: extra.signal, payer: servePayer };
  let progress = 0;
  let last: string | undefined;
  return {
    signal: extra.signal,
    payer: servePayer,
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
  if (!tool) return errorResponse(new Error(`Unknown tool: ${name}`));

  try {
    const result = await runTool(tool, params, call);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(stamp(result), null, 2) }],
    };
  } catch (err) {
    return errorResponse(err instanceof Error ? err : new Error(String(err)));
  }
}

function errorResponse(error: Error) {
  const { errorCode } = classifyError(error);
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
  installCliHost();
  // The server runs facades on demand (balance/transfer/etc.). A cold shielded
  // sync would overflow Node's default heap, so re-exec once at startup with
  // more headroom. No-op when launched via `mn --mcp` (already bumped) or when
  // the heap is already large enough. See lib/heap-guard.ts.
  await ensureHeapForSync();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
