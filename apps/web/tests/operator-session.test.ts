import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { readApiResponse, operatorSessionExpiredEvent } from '../src/lib/api-client.js';

test('operator auth rejection signals the gate; carrier expiry and service errors do not', async (t) => {
  const target = new EventTarget();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  let locks = 0;
  target.addEventListener(operatorSessionExpiredEvent, () => {
    locks++;
  });
  const schema = z.object({ ok: z.literal(true) });
  for (const error of ['SESSION_REQUIRED', 'TWIN_UNAVAILABLE', 'OPERATOR_AUTH_REQUIRED']) {
    await assert.rejects(
      readApiResponse(
        Response.json({ ok: false, error }, { status: error === 'TWIN_UNAVAILABLE' ? 503 : 401 }),
        schema,
      ),
      { message: error },
    );
    assert.equal(locks, error === 'OPERATOR_AUTH_REQUIRED' ? 1 : 0);
  }
  await assert.rejects(
    readApiResponse(
      Response.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 503 }),
      schema,
    ),
  );
  assert.equal(
    locks,
    1,
    'Backend operator-key configuration failure must not sign out the browser',
  );
  assert.deepEqual(await readApiResponse(Response.json({ ok: true }), schema), { ok: true });
  assert.equal(locks, 1);
});
