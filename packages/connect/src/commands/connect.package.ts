// The connect package's commands, as a program's registry installs them:
// createPackageRegistry([..., connectCommands, ...]).

import type { CommandPackage } from '@kuiralabs/midnight-cli-core';
import { serveDefinition } from './serve.definition.ts';
import { connectGuidance } from './connect.guidance.ts';
import { connectCodes } from './connect.codes.ts';

/** The connect package's commands, their agent guidance and codes, as one entry of a program's registry. */
export const connectCommands: CommandPackage = { name: 'connect', commands: [serveDefinition], guidance: connectGuidance, codes: connectCodes };
