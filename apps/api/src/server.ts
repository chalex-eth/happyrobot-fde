import { handleRequest } from './app.js';
import { createApiServer } from './transport/http/node-server.js';
import { serverConfig } from './config/env.js';
const { API_HOST, API_PORT } = serverConfig();
const server = createApiServer(handleRequest);
server.listen(API_PORT, API_HOST, () =>
  console.log(`Carrier API listening on ${API_HOST}:${API_PORT}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10_000).unref();
  });
