// The connector's wire types are the DApp Connector API specification's: the
// transport owns its copy so no SDK package is imported outside the engine,
// and this test keeps the copy equal to the specification's.

import { describe, expect, expectTypeOf, it } from 'vitest';
import { ErrorCodes, type APIError as SpecAPIError, type ErrorCode as SpecErrorCode } from '@midnightntwrk/dapp-connector-api';
import type { APIError, ErrorCode } from '../lib/ws-rpc.ts';
import { createApiError } from '../lib/ws-rpc.ts';

describe("the connector's API types", () => {
  it('name exactly the error codes the specification names', () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<SpecErrorCode>();
    const codes: ErrorCode[] = ['InternalError', 'Rejected', 'InvalidRequest', 'PermissionRejected', 'Disconnected'];
    expect([...codes].sort()).toStrictEqual(Object.values(ErrorCodes).sort());
  });

  it("are the specification's error", () => {
    expectTypeOf<APIError>().toEqualTypeOf<SpecAPIError>();
    expect(createApiError('Rejected', 'no')).toMatchObject({ type: 'DAppConnectorAPIError', code: 'Rejected', reason: 'no', message: 'no' });
  });
});
