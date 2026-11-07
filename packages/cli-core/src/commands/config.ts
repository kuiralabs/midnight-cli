// config command — get/set persistent CLI config
// config get [key] → stdout (no key: every value)
// config set <key> <value> → success message on stderr

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { getValidNetworkNames, isValidNetworkName, type NetworkName } from '../lib/network.ts';
import { UsageError } from '../lib/errors.ts';
import { getConfigValue, listConfigValues, setConfigValue, unsetConfigValue, getValidConfigKeys } from '../lib/cli-config.ts';
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

  const key = args.positionals[0];
  // `config get` alone lists every value, the project id masked as `config get` shows it.
  if (!key && action === 'get') {
    const values = listConfigValues(root, scope);
    if (hasFlag(args, 'json')) {
      ctx.output.result({ action: 'get', ...(scope === undefined ? {} : { network: scope }), values });
      return;
    }
    const width = Math.max(...Object.keys(values).map((name) => name.length));
    ctx.output.stdout(Object.entries(values).map(([name, value]) => `${name.padEnd(width)}  ${value}`).join('\n') + '\n');
    return;
  }
  if (!key) {
    throw new UsageError(
      `Missing config key.\n` +
      `Valid keys: ${getValidConfigKeys().join(', ')}`
    );
  }

  if (action === 'get') {
    const value = getConfigValue(key, root, scope);
    if (hasFlag(args, 'json')) {
      ctx.output.result({ action: 'get', key, value });
      return;
    }
    ctx.output.stdout(value + '\n');
  } else if (action === 'unset') {
    unsetConfigValue(key, root, scope);
    const displayValue = key === 'network' ? '(default)' : '(removed)';
    if (hasFlag(args, 'json')) {
      ctx.output.result({ action: 'unset', key, value: displayValue });
      return;
    }
    ctx.output.stderr(green('✓') + ` ${key} ${displayValue}\n`);
  } else {
    const value = args.positionals[1];
    if (value === undefined) {
      throw new UsageError(`Missing value for config set.\nUsage: midnight config set ${key} <value>`);
    }
    setConfigValue(key, value, root, scope);
    // A project id is a secret: what was set is said the way `config get` shows it.
    const shown = key === 'blockfrost-project-id' ? getConfigValue(key, root, scope) : value;
    if (hasFlag(args, 'json')) {
      ctx.output.result({ action: 'set', key, value: shown });
      return;
    }
    ctx.output.stderr(green('✓') + ` ${key} = ${shown}\n`);
  }
}
