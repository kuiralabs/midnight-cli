// The grant package's commands, as a program's registry installs them:
// createPackageRegistry([..., grantCommands, ...]).

import type { CommandPackage } from '@kuiralabs/midnight-cli-core';
import { grantDefinition } from './grant.definition.ts';
import { grantGuidance } from './grant.guidance.ts';
import { grantCodes } from './grant.codes.ts';

/** The grant package's commands, their agent guidance and codes, as one entry of a program's registry. */
export const grantCommands: CommandPackage = { name: 'grant', commands: [grantDefinition], guidance: grantGuidance, codes: grantCodes };
