import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../src/transport/http/node-server.js';
import { handleRequest } from '../src/app.js';

test('independent API preserves route methods, origin gates and MCP authentication', async (t) => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    OPERATOR_PASSWORD: process.env.OPERATOR_PASSWORD,
    OPERATOR_SESSION_SECRET: process.env.OPERATOR_SESSION_SECRET,
  };
  Object.assign(process.env, {
    NODE_ENV: 'development',
    OPERATOR_PASSWORD: 'correct-horse-battery-staple',
    OPERATOR_SESSION_SECRET: 'operator-session-secret-for-tests-'.repeat(2),
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const server = createApiServer(handleRequest);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/api/operator/calls?call_id=invalid')).status, 401);
  assert.equal(
    (await fetch(base + '/api/operator/review', { method: 'POST', body: '{}' })).status,
    401,
  );
  assert.equal((await fetch(base + '/api/local/calls')).status, 405);
  assert.equal((await fetch(base + '/missing')).status, 404);
  const mcp = await fetch(base + '/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.ok([401, 503].includes(mcp.status));
});
