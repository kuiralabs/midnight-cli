// A serve on the one port a caller asked for (mn test's, whose suites name
// it): an mn serve there is reused when it can pay for the run, any other
// process there is refused, saying how to stop only that process, and a new
// serve binds the port before its wallet syncs.

import { DEFAULT_SERVE_PORT, throwIfCancelled } from '@kuiralabs/midnight-cli-core';
import { isPortInUse, reusedServe, serveReuseRefusal, startServe, type ServeHandle, type ServeManagerOptions } from './serve-manager.ts';

/** The port a serve was to use is taken by a process that can't serve the command: why, and how to stop only that process. */
export class ServeNotReusableError extends Error {
  readonly code = 'SERVE_PORT_IN_USE';

  constructor(readonly port: number, readonly reason: string) {
    super(`${reason} ${stopAdvice(port)}`);
    this.name = 'ServeNotReusableError';
    Object.setPrototypeOf(this, ServeNotReusableError.prototype);
  }
}

/** How to stop only the process listening on `port`, not every mn serve. */
function stopAdvice(port: number): string {
  return process.platform === 'win32'
    ? `Stop the process listening on port ${port} (find its PID with \`netstat -ano | findstr :${port}\`, then \`taskkill /PID <pid>\`) and retry, or use another port.`
    : `Stop the process listening on port ${port} (find its PID with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, then \`kill <pid>\`) and retry, or use another port.`;
}

/**
 * A serve on `port` (the default port when unset) for the options' network,
 * chain and wallet: the one running there when it can pay for them (its stop
 * does nothing), else a new one in this process on that port. A port held by
 * anything else is refused with ServeNotReusableError, before any sync.
 */
export async function startServeOrReuse(options: ServeManagerOptions): Promise<ServeHandle> {
  const port = options.port ?? DEFAULT_SERVE_PORT;
  throwIfCancelled(options.signal);
  if (await isPortInUse(port)) {
    const refusal = await serveReuseRefusal(port, options);
    if (refusal !== undefined) throw new ServeNotReusableError(port, refusal);
    return reusedServe(port, options);
  }
  try {
    return await startServe({ ...options, port });
  } catch (err) {
    // Taken between the check and the bind: the bind comes before the sync, so nothing was synced for nothing.
    if (((err as Error).cause as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE') {
      throw new ServeNotReusableError(port, `Port ${port} was taken while mn serve was starting.`);
    }
    throw err;
  }
}
