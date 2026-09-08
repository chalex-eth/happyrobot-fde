import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/app.js';
import { rejectNonLocalRequest } from '../src/transport/http/middleware/local-origin.js';
import { mockOtpEnabled } from '../src/modules/verification/otp.js';
import { sessionCookie } from '../src/transport/http/middleware/session-cookie.js';

const origin = 'https://carrier-demo.example';
const password = 'hosted-demo-test-password';
function configure(t: { after: (fn: () => void) => void }) {
  const before = process.env;
  process.env = {
    NODE_ENV: 'production',
    HOSTED_DEMO_ENABLED: 'true',
    APP_PUBLIC_URL: origin,
    OTP_DEMO_MODE: 'true',
    OTP_DELIVERY_MODE: 'mock',
    OTP_HASH_SECRET: 'o'.repeat(32),
    BOOKING_TMS_MODE: 'mock',
    OPERATOR_PASSWORD: password,
    OPERATOR_SESSION_SECRET: 's'.repeat(32),
    MCP_AUTH_TOKEN: 'mcp-test-token',
  };
  t.after(() => {
    process.env = before;
  });
}
function request(path: string, cookie = '', requestOrigin = origin, body = '{}') {
  return new Request(origin + path, {
    method: 'POST',
    headers: {
      host: new URL(origin).host,
      origin: requestOrigin,
      cookie,
      'content-type': 'application/json',
    },
    body,
  });
}

test('hosted demo requires login at the API and permits only its HTTPS origin', async (t) => {
  configure(t);
  assert.equal((await handleRequest(request('/api/local/calls'))).status, 401);
  assert.equal(
    (
      await handleRequest(
        request('/api/operator/auth', '', 'https://evil.example', JSON.stringify({ password })),
      )
    ).status,
    403,
  );
  const login = await handleRequest(
    request('/api/operator/auth', '', origin, JSON.stringify({ password })),
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!;
  assert.match(cookie, /Path=\/api;/);
  assert.match(cookie, /Secure/);
  assert.equal(rejectNonLocalRequest(request('/api/local/calls', cookie)), undefined);
  assert.equal(
    rejectNonLocalRequest(request('/api/local/calls', cookie, 'http://localhost:3000'))?.status,
    403,
  );
  assert.equal(
    rejectNonLocalRequest(request('/api/local/calls', cookie, 'https://other.vercel.app'))?.status,
    403,
  );
  assert.equal(
    rejectNonLocalRequest(
      request('/api/local/calls', cookie.replace('operator_session=', 'operator_session=tampered')),
    )?.status,
    401,
  );
  assert.equal(mockOtpEnabled(), true);
  assert.match(sessionCookie('a'.repeat(64)), /Secure/);
});

test('hosted demo refuses real booking and adversarial configuration before dispatch', async (t) => {
  configure(t);
  process.env.BOOKING_TMS_MODE = 'live';
  assert.equal((await handleRequest(request('/api/mcp'))).status, 503);
  process.env.BOOKING_TMS_MODE = 'mock';
  process.env.ADVERSARIAL_MCP_ENABLED = 'true';
  assert.equal((await handleRequest(request('/api/mcp'))).status, 503);
  process.env.ADVERSARIAL_MCP_ENABLED = 'false';
  process.env.APP_PUBLIC_URL = 'http://carrier-demo.example';
  assert.equal((await handleRequest(request('/api/mcp'))).status, 503);
});

test('production without hosted opt-in keeps local routes and screen OTP disabled', async (t) => {
  configure(t);
  process.env.HOSTED_DEMO_ENABLED = 'false';
  assert.equal((await handleRequest(request('/api/local/calls'))).status, 404);
  assert.equal(mockOtpEnabled(), false);
});

test('MCP remains server-to-server bearer authentication, separate from browser login', async (t) => {
  configure(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const mcp = (headers: Record<string, string>) =>
    new Request(origin + '/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    });
  assert.equal((await handleRequest(mcp({}))).status, 401);
  assert.equal(
    (await handleRequest(mcp({ authorization: 'Bearer mcp-test-token', origin }))).status,
    403,
  );
  const response = await handleRequest(mcp({ authorization: 'Bearer mcp-test-token' }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.result.tools.length, 11);
});
