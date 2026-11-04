// The contract package's commands, as a program's registry installs them:
// createPackageRegistry([..., contractCommands, ...]).

import type { CommandPackage } from '@kuiralabs/midnight-cli-core';
import { inspectCostDefinition } from './inspect-cost.definition.ts';
import { contractDefinition } from './contract.definition.ts';
import { contractGuidance } from './contract.guidance.ts';
import { contractCodes } from './contract.codes.ts';

/** The contract package's commands, their agent guidance and codes, as one entry of a program's registry. */
export const contractCommands: CommandPackage = { name: 'contract', commands: [inspectCostDefinition, contractDefinition], guidance: contractGuidance, codes: contractCodes };
