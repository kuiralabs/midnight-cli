// @kuiralabs/midnight-connect: mn serve for a program and the packages above.
// The payer a paying command is given (one that starts or reuses an mn serve
// on a port and pays through its wallet), the serve manager that starts or
// reuses that serve and asks which network one on a port runs, and the
// WebSocket JSON-RPC server the DApp connector API is served over, with the
// handlers it is given. Each name is listed, so the API is what this file
// says. The serve command and connect's guidance are "./commands".

export { servePayer, servePayerAt } from './lib/serve-payer.ts';
export { probeServe, probeServeNetwork, reuseServeOrStartAnother, type ServeHandle, type ServeManagerOptions, type ServeProbe, serveWalletContractKeys } from './lib/serve-manager.ts';
export { ServeNotReusableError, startServeOrReuse } from './lib/serve-on-port.ts';
export { originOfPage } from './lib/allowed-origins.ts';
export { createRpcServer, type JsonRpcRequest, type RpcConnection, type RpcServer, type RpcServerOptions } from './lib/ws-rpc.ts';
