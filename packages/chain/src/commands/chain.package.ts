// The chain package's commands, as a program's registry installs them:
// createPackageRegistry([..., chainCommands, ...]).

import type { CommandPackage } from '@kuiralabs/midnight-cli-core';
import { statusDefinition } from './status.definition.ts';
import { txDefinition } from './tx.definition.ts';
import { chainGuidance } from './chain.guidance.ts';
import { chainCodes } from './chain.codes.ts';

/** The chain package's commands, their agent guidance and codes, as one entry of a program's registry. */
export const chainCommands: CommandPackage = { name: 'chain', commands: [statusDefinition, txDefinition], guidance: chainGuidance, codes: chainCodes };
