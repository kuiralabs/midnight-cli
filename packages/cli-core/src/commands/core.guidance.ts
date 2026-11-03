// What the core package (config, and the error codes its base raises) tells
// agents: its pieces of `help --agent` and of the two skills,
// each naming its section and its place there, and its tools' rows in the
// manual's tools table.

import { codeGuidancePieces, type PackageGuidance } from '../lib/agent-guidance.ts';
import { coreCodes } from './core.codes.ts';

export const coreGuidance: PackageGuidance = {
  pieces: [
    // Its error codes' rows in the manual and the full skill, from their definitions.
    ...codeGuidancePieces(coreCodes),
  ],
  toolsTable: [
    { tool: 'midnight_config_get', group: 'configuration', order: 10, description: ['Read a config value'] },
    { tool: 'midnight_config_set', group: 'configuration', order: 20, description: ['Write a config value'] },
    { tool: 'midnight_config_unset', group: 'configuration', order: 30, description: ['Reset a config value to default'] },
  ],
};
