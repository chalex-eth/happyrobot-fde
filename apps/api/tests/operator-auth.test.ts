import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as login, GET as session, DELETE as logout } from '../src/transport/http/routes/operator/auth/route.js';
import { GET as calls } from '../src/transport/http/routes/operator/calls/route.js';
import { GET as inventory } from '../src/transport/http/routes/operator/inventory/route.js';
import { POST as review } from '../src/transport/http/routes/operator/review/route.js';

const password = 'correct-horse-battery-staple';
const sessionSecret = 'operator-session-secret-for-tests-'.repeat(2);

function configureOperator(t: { after: (callback: () => void) => void }, nodeEnv = 'development') {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    OPERATOR_PASSWORD: process.env.OPERATOR_PASSWORD,
    OPERATOR_SESSION_SECRET: process.env.OPERATOR_SESSION_SECRET,
  };
  Object.assign(process.env, {
    NODE_ENV: nodeEnv,
    OPERATOR_PASSWORD: password,
    OPERATOR_SESSION_SECRET: sessionSecret,
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/operator/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('shared operator password creates a scoped session and supports logout', async (t) => {
  configureOperator(t);

  const wrong = await login(jsonRequest({ password: 'wrong-password' }));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, 'OPERATOR_AUTH_REQUIRED');
  assert.equal(wrong.headers.get('set-cookie'), null);

  const authenticated = await login(jsonRequest({ password }));
  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), { ok: true, role: 'operator' });
  const cookie = authenticated.headers.get('set-cookie');
  assert.ok(cookie);
  assert.match(cookie, /operator_session=[^;]+/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/api\/operator/);
  assert.doesNotMatch(cookie, new RegExp(password));

  assert.deepEqual(
    await (await session(new Request('http://localhost:3000/api/operator/auth', { headers: { cookie } }))).json(),
    { ok: true, role: 'operator' },
  );
  assert.equal(
    (await session(new Request('http://localhost:3000/api/operator/auth', { headers: { cookie: cookie.replace('operator_session=', 'operator_session=x') } }))).status,
    401,
  );

  const cleared = await logout(new Request('http://localhost:3000/api/operator/auth', { headers: { cookie } }));
  assert.equal(cleared.status, 200);
  assert.match(cleared.headers.get('set-cookie') ?? '', /operator_session=;/);
  assert.match(cleared.headers.get('set-cookie') ?? '', /Max-Age=0/);
});

test('operator data and mutation routes require the shared session before downstream work', async (t) => {
  configureOperator(t);
  const originHeaders = { host: 'localhost:3000', origin: 'http://localhost:3000' };
  const unauthenticatedCalls = await calls(
    new Request('http://localhost:3000/api/operator/calls?call_id=invalid', { headers: originHeaders }),
  );
  assert.equal(unauthenticatedCalls.status, 401);
  assert.equal((await unauthenticatedCalls.json()).error, 'OPERATOR_AUTH_REQUIRED');
  assert.equal(
    (await inventory(new Request('http://localhost:3000/api/operator/inventory'))).status,
    401,
  );
  assert.equal(
    (
      await review(
        new Request('http://localhost:3000/api/operator/review', {
          method: 'POST',
          headers: { ...originHeaders, 'content-type': 'application/json' },
          body: '{}',
        }),
      )
    ).status,
    401,
  );

  const authenticated = await login(jsonRequest({ password }));
  const cookie = authenticated.headers.get('set-cookie');
  assert.ok(cookie);
  assert.equal(
    (
      await calls(
        new Request('http://localhost:3000/api/operator/calls?call_id=invalid', {
          headers: { ...originHeaders, cookie },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await review(
        new Request('http://localhost:3000/api/operator/review', {
          method: 'POST',
          headers: {
            host: 'localhost:3000',
            origin: 'https://evil.example',
            cookie,
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      )
    ).status,
    403,
  );
});

test('production operator cookies are marked secure', async (t) => {
  configureOperator(t, 'production');
  const response = await login(jsonRequest({ password }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie') ?? '', /Secure/);
});
