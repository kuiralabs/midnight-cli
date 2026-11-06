// What the fixture command's handler imports: it throws a coded error.

import { NotAnOfferError } from '@kuiralabs/midnight-cli-core/engine';

export function refuse(reason: string): never {
  throw new NotAnOfferError(reason);
}
