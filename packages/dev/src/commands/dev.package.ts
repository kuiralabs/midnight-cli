// The dev package's commands, as a program's registry installs them:
// createPackageRegistry([..., devCommands, ...]).

import type { CommandPackage } from '@kuiralabs/midnight-cli-core';
import { testDefinition } from './test.definition.ts';
import { devDefinition } from './dev.definition.ts';
import { localnetDefinition } from './localnet.definition.ts';
import { devGuidance } from './dev.guidance.ts';
import { devCodes } from './dev.codes.ts';

/** The dev package's commands, their agent guidance and codes, as one entry of a program's registry. */
export const devCommands: CommandPackage = { name: 'dev', commands: [testDefinition, devDefinition, localnetDefinition], guidance: devGuidance, codes: devCodes };
