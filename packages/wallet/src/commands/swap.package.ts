// The swap command, as a program's registry installs it beside the wallet's:
// createPackageRegistry([..., walletCommands, swapCommands, ...]).

import type { CommandPackage } from '@kuiralabs/midnight-cli-core';
import { swapDefinition } from './swap.definition.ts';
import { swapGuidance } from './swap.guidance.ts';

/** The swap command and its agent guidance, as one entry of a program's registry; its codes are the wallet's. */
export const swapCommands: CommandPackage = { name: 'swap', commands: [swapDefinition], guidance: swapGuidance };
