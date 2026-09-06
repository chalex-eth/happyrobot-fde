import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../src/transport/http/routes/local/tms/route.js';

test('local console uses server credentials, rejects foreign origins, and is disabled in production', async () => {
  const env: Record<string, string | undefined> = process.env;
  const previous = { NODE_ENV: env.NODE_ENV, LOCAL_API_TOKEN: env.LOCAL_API_TOKEN };
  const request = (origin: string, host = '127.0.0.1:3000') =>
    new Request('http://127.0.0.1:3000/api/local/tms', {
      method: 'POST',
      headers: { origin, host, 'content-type': 'application/json' },
      body: '{}',
    });
  try {
    env.NODE_ENV = 'development';
    env.LOCAL_API_TOKEN = 'server-only-test-token';
    const local = await POST(request('http://127.0.0.1:3000'));
    assert.equal(local.status, 400); // Auth succeeded; invalid command stops before TCP.
    const body = await local.text();
    assert.ok(body.includes('INVALID_COMMAND'));
    assert.ok(!body.includes(env.LOCAL_API_TOKEN));
    for (const origin of [
      '',
      'null',
      'https://evil.example',
      'http://127.0.0.1:4000',
      'http://127.0.0.1:3000/',
    ]) {
      assert.equal((await POST(request(origin))).status, 403);
    }
    assert.equal((await POST(request('http://127.0.0.1:3000', 'evil.example'))).status, 403);
    delete env.LOCAL_API_TOKEN;
    assert.equal((await POST(request('http://127.0.0.1:3000'))).status, 503);
    env.NODE_ENV = 'production';
    assert.equal((await POST(request('http://127.0.0.1:3000'))).status, 404);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});
