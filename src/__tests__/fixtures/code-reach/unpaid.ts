// Listed by the fixture barrel beside refuses.ts: it throws NoPayerError (NO_PAYER).

import { NoPayerError } from '@kuiralabs/midnight-cli-core';

export function refuseUnpaid(command: string): never {
  throw new NoPayerError(command);
}
