// @kuiralabs/midnight-cli-core/commands: core's own command (config), its
// codes and the code sets other packages' definitions name, and its agent
// guidance, for the shell that installs them.

export { configDefinition } from './commands/config.definition.ts';
export { coreCodes, ENGINE_SYNC, EVERY_COMMAND, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from './commands/core.codes.ts';
export { coreGuidance } from './commands/core.guidance.ts';
export { coreCommands } from './commands/core.package.ts';
