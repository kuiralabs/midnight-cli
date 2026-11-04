// The wallet package's commands, as a program's registry installs them:
// createPackageRegistry([..., walletCommands, ...]).

import type { CommandPackage } from '@kuiralabs/midnight-cli-core';
import { walletDefinition } from './wallet.definition.ts';
import { generateDefinition } from './generate.definition.ts';
import { infoDefinition } from './info.definition.ts';
import { balanceDefinition } from './balance.definition.ts';
import { addressDefinition } from './address.definition.ts';
import { genesisAddressDefinition } from './genesis-address.definition.ts';
import { airdropDefinition } from './airdrop.definition.ts';
import { transferDefinition } from './transfer.definition.ts';
import { dustDefinition } from './dust.definition.ts';
import { cacheDefinition } from './cache.definition.ts';
import { walletGuidance } from './wallet.guidance.ts';
import { walletCodes } from './wallet.codes.ts';

/** The wallet package's commands, their agent guidance and codes, as one entry of a program's registry. */
export const walletCommands: CommandPackage = { name: 'wallet', commands: [walletDefinition, generateDefinition, infoDefinition, balanceDefinition, addressDefinition, genesisAddressDefinition, airdropDefinition, transferDefinition, dustDefinition, cacheDefinition], guidance: walletGuidance, codes: walletCodes };
