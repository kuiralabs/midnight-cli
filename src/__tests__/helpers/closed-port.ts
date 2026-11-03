// A port on 127.0.0.1 that nothing listens on: one the system just gave out and
// took back, so a connection to it is refused. (fetch refuses port 9 itself, as
// a "bad port", without connecting.)

import { createServer, type AddressInfo } from 'node:net';

export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
