import { handleRequest } from './app.js';
import { createApiServer } from './transport/http/node-server.js';
import { serverConfig } from './config/env.js';
const { host, port } = serverConfig();
const server = createApiServer(handleRequest);
server.listen(port, host, () =>
  console.log(`Carrier API listening on ${host}:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10_000).unref();
  });
