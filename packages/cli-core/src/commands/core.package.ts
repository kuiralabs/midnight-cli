// The core package's commands, as a program's registry installs them:
// createPackageRegistry([..., coreCommands, ...]).

import type { CommandPackage } from '../lib/command-definition.ts';
import { configDefinition } from './config.definition.ts';
import { coreGuidance } from './core.guidance.ts';
import { coreCodes } from './core.codes.ts';

/** The core package's commands, their agent guidance and codes, as one entry of a program's registry. */
export const coreCommands: CommandPackage = { name: 'core', commands: [configDefinition], guidance: coreGuidance, codes: coreCodes };
