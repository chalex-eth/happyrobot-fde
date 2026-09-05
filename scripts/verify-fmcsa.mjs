import assert from 'node:assert/strict';

const mcNumber = process.argv[2];
assert.ok(mcNumber, 'Usage: npm run verify:fmcsa -- MC-1515');
const base = new URL(process.env.LOCAL_BASE_URL ?? 'http://127.0.0.1:3000');
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Local HTTP only');
try {
  const started = await fetch(new URL('/api/local/calls', base), {
    method: 'POST', headers: { origin: base.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start' }), signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  assert.ok(started.ok, 'Could not create pending Twin call');
  const cookie = started.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Missing call cookie');
  const response = await fetch(new URL('/api/local/carriers', base), {
    method: 'POST', headers: { origin: base.origin, 'content-type': 'application/json', cookie },
    body: JSON.stringify({ mcNumber }), signal: AbortSignal.timeout(22000), redirect: 'error',
  });
  const result = await response.json();
  console.log(JSON.stringify({ httpStatus: response.status, ok: result.ok, error: result.error, outcome: result.check?.outcome, reason: result.check?.reason, requestId: result.requestId }));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(result.requestId);
  assert.equal(response.headers.get('x-request-id'), result.requestId);
  if (!response.ok || !result.ok || result.check?.outcome === 'unverified') process.exitCode = 1;
} catch { console.error('Local FMCSA verification failed; no carrier authority has been confirmed.'); process.exitCode = 1; }
