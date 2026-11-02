// What the core package (config, and the error codes its base raises) tells
// agents: its pieces of `help --agent` and of the two skills,
// each naming its section and its place there, and its tools' rows in the
// manual's tools table.

import type { PackageGuidance } from '../lib/agent-guidance.ts';

export const coreGuidance: PackageGuidance = {
  pieces: [
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 10,
      body: `  INVALID_ARGS            2     Missing or invalid arguments
`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 30,
      body: `  NETWORK_ERROR           4     Connection refused, timeout, DNS failure
`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 80,
      body: `  AMBIGUOUS_LOCAL_STACKS  4     Several local stacks run; pass endpoint flags
`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 110,
      body: `  WRONG_PASSPHRASE        2     mn's passphrase was wrong, or a sealed secret
                                was changed
`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 130,
      body: `  BLOCKFROST_PROJECT_ID_REQUIRED 4
                                Preprod is served by Blockfrost and no project
                                id is set: config set blockfrost-project-id
  BLOCKFROST_PROJECT_ID_REJECTED 4
                                Blockfrost refused the project id (HTTP 403)
  BLOCKFROST_LIMIT_REACHED 4    Blockfrost's plan or rate limit; wait and retry
  ENDPOINT_SHUT_DOWN      4     An endpoint set by flag or config was shut down
                                by its operator; unset it
  CANCELLED               7     Operation cancelled (SIGINT)
  UNKNOWN                 1     Unclassified error
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 20,
      body: `| \`NETWORK_ERROR\` | Indexer/node/proof-server connection refused or DNS failure. | Check \`midnight_localnet_status()\` or the endpoints the user configured; on this build \`midnight_localnet_up()\` is refused, so ask the user to start their ledger-9 stack. |
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 60,
      body: `| \`AMBIGUOUS_LOCAL_STACKS\` | Several local Midnight stacks are running and no endpoints are configured, so mn won't guess. | Ask the user which stack to use; they set its endpoints with \`midnight config set\`. Don't retry blindly. |
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 90,
      body: `| \`WRONG_PASSPHRASE\` | \`MN_PASSPHRASE\` is not the passphrase mn's secrets were encrypted with, or a sealed file was changed. | Ask the user to correct \`MN_PASSPHRASE\` in the MCP server's environment. Nothing was changed. |
| \`BLOCKFROST_PROJECT_ID_REQUIRED\` | The network (preprod) is served by Blockfrost and no project id is set. | Ask the user to create a Midnight preprod project at https://blockfrost.io and run \`midnight config set blockfrost-project-id <project id>\` themselves. Never ask them to paste the id into the chat. Don't retry until they have. |
| \`BLOCKFROST_PROJECT_ID_REJECTED\` | Blockfrost refused the project id (HTTP 403): mistyped, revoked, or for another network. | Ask the user to check it at blockfrost.io and set it again. Don't retry blindly. |
| \`BLOCKFROST_LIMIT_REACHED\` | Blockfrost's plan limit or rate limit. | Wait and retry once; if it persists, tell the user it is their Blockfrost plan. |
| \`ENDPOINT_SHUT_DOWN\` | An endpoint set by flag or config was shut down by its operator (the old preprod indexer). | \`midnight_config_unset({ key: "indexer-ws" })\` (and \`node\` if set), then retry. |
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 110,
      body: `| \`INVALID_ARGS\` | Missing/invalid argument. | Show the message to the user verbatim — it names the missing field. |
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 130,
      body: `| \`CANCELLED\` | Operation was aborted (SIGINT, or the MCP call was cancelled). | A transaction already submitted may still have landed: read the state first (\`midnight_grant_status\`, \`midnight_balance\`). Don't retry without confirming with the user. |
| \`UNKNOWN\` | Error didn't match any known classifier. | Surface the message to the user. If reproducible, a new code may be warranted. |
`,
    },
  ],
  toolsTable: [
    { tool: 'midnight_config_get', group: 'configuration', order: 10, description: ['Read a config value'] },
    { tool: 'midnight_config_set', group: 'configuration', order: 20, description: ['Write a config value'] },
    { tool: 'midnight_config_unset', group: 'configuration', order: 30, description: ['Reset a config value to default'] },
  ],
};
