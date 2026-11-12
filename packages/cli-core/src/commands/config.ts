// config command — get/set persistent CLI config
// config get [key] → stdout (no key: every value); a key that isn't set prints nothing (null in JSON)
// config set <key> <value> → success message on stderr; `-` reads a Blockfrost project id from the terminal or the standard input

import { type ParsedArgs, getFlag, hasFlag, MINIMAL_FLAG } from '../lib/argv.ts';
import { getValidNetworkNames, isValidNetworkName, type NetworkName } from '../lib/network.ts';
import { UsageError } from '../lib/errors.ts';
import { getConfigValue, listConfigValues, setConfigValue, unsetConfigValue, getValidConfigKeys } from '../lib/cli-config.ts';
import { readProcessStandardInput } from '../lib/read-input.ts';
import { green } from '../ui/colors.ts';
import type { CallContext } from '../lib/call-context.ts';

export default async function configCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const action = args.subcommand;

  if (!action || !['get', 'set', 'unset'].includes(action)) {
    throw new UsageError(
      `Usage: midnight config <get|set|unset> <key> [value]\n` +
      `Valid keys: ${getValidConfigKeys().join(', ')}`
    );
  }

  // An endpoint key can be read or written for a network other than the selected one.
  const networkFlag = getFlag(args, 'network');
  if (networkFlag !== undefined && !isValidNetworkName(networkFlag)) {
    throw new UsageError(`Invalid network: "${networkFlag}"\nValid networks: ${getValidNetworkNames().join(', ')}`);
  }
  const scope = networkFlag as NetworkName | undefined;
  const root = ctx.config.paths.stateRoot;
  // A project id in the environment is the one in use, and is shown as such.
  const environment = ctx.config.settings;

  const key = args.positionals[0];
  // `config get` alone lists every value, the project id masked as `config get` shows it.
  if (!key && action === 'get') {
    const values = listConfigValues(root, scope, environment);
    if (hasFlag(args, 'json')) {
      ctx.output.result({ action: 'get', ...(scope === undefined ? {} : { network: scope }), values });
      return;
    }
    const width = Math.max(...Object.keys(values).map((name) => name.length));
    ctx.output.stdout(Object.entries(values).map(([name, value]) => `${name.padEnd(width)}  ${value ?? NOT_SET}`).join('\n') + '\n');
    return;
  }
  if (!key) {
    throw new UsageError(
      `Missing config key.\n` +
      `Valid keys: ${getValidConfigKeys().join(', ')}`
    );
  }

  if (action === 'get') {
    // A key that isn't set prints nothing, so `$(mn config get wallet)` is empty, and is null in JSON.
    const value = getConfigValue(key, root, scope, environment);
    if (hasFlag(args, 'json')) {
      ctx.output.result({ action: 'get', key, value: value ?? null });
      return;
    }
    if (value !== undefined) ctx.output.stdout(value + '\n');
  } else if (action === 'unset') {
    const removedFrom = unsetConfigValue(key, root, scope);
    if (removedFrom !== undefined) {
      // The project id is kept per network: what was removed is said by network, and so is nothing.
      const said = removedFrom.length > 0 ? `removed for ${removedFrom.join(' and ')}` : `none was set${scope === undefined ? '' : ` for ${scope}`}`;
      if (hasFlag(args, 'json')) {
        ctx.output.result({ action: 'unset', key, value: null, removed: removedFrom });
        return;
      }
      ctx.output.stderr((removedFrom.length > 0 ? green('✓') : '·') + ` ${key} ${said}\n`);
      return;
    }
    const displayValue = key === 'network' ? '(default)' : '(removed)';
    if (hasFlag(args, 'json')) {
      ctx.output.result({ action: 'unset', key, value: displayValue });
      return;
    }
    ctx.output.stderr(green('✓') + ` ${key} ${displayValue}\n`);
  } else {
    const given = args.positionals[1];
    if (given === undefined) {
      throw new UsageError(`Missing value for config set.\nUsage: midnight config set ${key} <value>`);
    }
    const value = given === VALUE_FROM_INPUT && key === PROJECT_ID_KEY ? await readProjectId(args, ctx) : given;
    setConfigValue(key, value, root, scope);
    // A project id is a secret: what was set is said the way `config get` shows it (not the environment's, which would win).
    const shown = key === PROJECT_ID_KEY ? getConfigValue(key, root, scope) : value;
    if (hasFlag(args, 'json')) {
      ctx.output.result({ action: 'set', key, value: shown });
      return;
    }
    ctx.output.stderr(green('✓') + ` ${key} = ${shown}\n`);
  }
}

const NOT_SET = '(not set)';
const PROJECT_ID_KEY = 'blockfrost-project-id';
/** The value that reads a project id from the terminal (unechoed) or the standard input, keeping it off the command line. */
const VALUE_FROM_INPUT = '-';

/**
 * A project id given as `-`: asked at the terminal with nothing echoed, else
 * read whole from the standard input (`… | mn config set blockfrost-project-id -`).
 * Refused in an MCP call, whose server's standard input is its protocol channel.
 */
async function readProjectId(args: ParsedArgs, ctx: CallContext): Promise<string> {
  if (hasFlag(args, MINIMAL_FLAG)) {
    throw new UsageError(`${PROJECT_ID_KEY} - reads the id from the standard input, which an MCP server has none of (it is its protocol channel). Ask the user to run "midnight config set ${PROJECT_ID_KEY} -" in their own terminal.`);
  }
  const prompter = ctx.host.prompter;
  const read = prompter?.isInteractive() ? await prompter.askSecret('Blockfrost project id: ') : readProcessStandardInput();
  const projectId = read?.trim() ?? '';
  if (projectId === '') throw new UsageError(`No Blockfrost project id was given on the ${prompter?.isInteractive() ? 'terminal' : 'standard input'}.`);
  return projectId;
}
