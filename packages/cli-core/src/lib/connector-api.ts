// The DApp Connector's wire protocol, as its handlers see it: the API's
// errors and the handler signature. SDK-free and transport-free, so the
// engine's connector and connect's WebSocket server share it.

/**
 * The DApp Connector API's error codes, as its specification names them
 * (dapp-connector-api's ErrorCodes; a test keeps the two equal). The wire
 * protocol is the same whatever SDK set serves it, so the transport owns it.
 */
export type ErrorCode = 'InternalError' | 'Rejected' | 'InvalidRequest' | 'PermissionRejected' | 'Disconnected';

/** The DApp Connector API's error: an Error with its code and reason, told apart by `type` (the specification's APIError). */
export type APIError = Error & {
  type: 'DAppConnectorAPIError';
  code: ErrorCode;
  reason: string;
};

// ── Handler context & type ──

/** Per-invocation context passed to each handler (scoped to the calling connection) */
export interface RpcHandlerContext {
  /** Send a JSON-RPC notification to the calling client */
  notify: (method: string, params?: Record<string, unknown>) => void;
  /** ID of the connection that sent this request (e.g. "conn_1") */
  connectionId: string;
  /** JSON-RPC request ID */
  requestId: number | string;
  /** Handlers can stash arbitrary data here for onResponse to read */
  metadata: Record<string, unknown>;
}

export type RpcHandler = (params: Record<string, unknown>, context: RpcHandlerContext) => Promise<unknown>;

// ── APIError factory ──

export function createApiError(code: ErrorCode, reason: string): APIError {
  const error = new Error(reason) as APIError;
  error.type = 'DAppConnectorAPIError';
  error.code = code;
  error.reason = reason;
  return error;
}

/** The error message when the operator declines an approval prompt. */
export const OPERATOR_REJECTED_MESSAGE = 'User rejected the request';
