import { mockCommandsAndFetch } from './helpers/commands.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../src/transport/http/routes/local/carriers/route.js';

test('carrier HTTP boundary enforces local access, validates input and hides provider secrets', async (t) => {
  const env: Record<string, string | undefined> = process.env;
  const previous = { NODE_ENV: env.NODE_ENV, FMCSA_API_KEY: env.FMCSA_API_KEY };
  const request = (
    body = '{"mcNumber":"1515"}',
    origin = 'http://127.0.0.1:3000',
    mime = 'application/json',
  ) =>
    new Request('http://127.0.0.1:3000/api/local/carriers', {
      method: 'POST',
      headers: { origin, host: '127.0.0.1:3000', 'content-type': mime },
      body,
    });
  let calls = 0;
  mockCommandsAndFetch(t, async () => {
    calls++;
    return new Response('private-key-response', { status: 403 });
  });
  try {
    env.NODE_ENV = 'production';
    env.FMCSA_API_KEY = 'private-key';
    assert.equal((await POST(request())).status, 404);
    env.NODE_ENV = 'development';
    assert.equal((await POST(request(undefined, 'https://evil.example'))).status, 403);
    for (const [body, status] of [
      ['{', 400],
      ['{}', 400],
      ['{"mcNumber":"1","extra":true}', 400],
      ['{"mcNumber":"x"}', 400],
      [' '.repeat(513), 413],
    ] as const)
      assert.equal((await POST(request(body))).status, status);
    assert.equal((await POST(request('{}', undefined, 'text/plain'))).status, 415);
    assert.equal(calls, 0);
    const denied = await POST(request());
    assert.equal(calls, 0);
    assert.equal(denied.status, 401);
    const body = await denied.text();
    assert.ok(!body.includes('private-key'));
    const result = JSON.parse(body);
    assert.equal(result.error, 'SESSION_REQUIRED');
    assert.equal(denied.headers.get('x-request-id'), result.requestId);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});
