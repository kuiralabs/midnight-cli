// The network a call acts on, with its endpoints resolved: the one it names,
// else the one saved with `midnight config set network`, else undeployed (as
// every command), with the endpoints it gives over the saved ones and the
// defaults. Without endpoints, `undeployed` resolves to whatever local stack
// docker shows, which is ambiguous when more than one runs.

import { getFlag, type ParsedArgs } from './argv.ts';
import { applyEndpointOverrides, endpointFlags, type EndpointOverrides, type NetworkName } from './network.ts';
import { resolveNetwork } from './resolve-network.ts';
import type { Host } from './host.ts';
import type { PayingTarget } from './payer.ts';

/** The network a call acts on, and the endpoints it uses instead of the saved or default ones. */
export interface NetworkChoice extends EndpointOverrides {
  /** The network's name; refused when it names none. Absent: the network set with `midnight config set network`, else undeployed. */
  network?: NetworkName;
}

/** What a command's --network, --node, --indexer-ws and --proof-server choose. */
export function networkChoiceFromArgs(args: ParsedArgs): NetworkChoice {
  return {
    // Resolving refuses a name that is no network's.
    network: getFlag(args, 'network') as NetworkName | undefined,
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
    proofServer: getFlag(args, 'proof-server'),
  };
}

/** The target `choice` names, from the config under the host's state root. */
export function networkTargetOf(host: Host, choice: NetworkChoice = {}): PayingTarget {
  return networkTargetUnder(host.paths().stateRoot, host, choice);
}

/** The target `choice` names, from the config under the state root `root` (a command's call's); the call runs in `host`. */
export function networkTargetUnder(root: string, host: Host, choice: NetworkChoice): PayingTarget {
  const { network } = choice;
  const endpoints: EndpointOverrides = { node: choice.node, indexerWS: choice.indexerWS, proofServer: choice.proofServer };
  const { name, config: networkConfig } = resolveNetwork({
    args: { command: 'network-target', subcommand: '', positionals: [], flags: { ...(network ? { network } : {}), ...endpointFlags(endpoints) } },
    configDir: root,
  }, host.settings());
  applyEndpointOverrides(networkConfig, endpoints, name, root);
  return { network: name, root, host, networkConfig, endpoints };
}
