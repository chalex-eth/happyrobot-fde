import test from 'node:test';
import assert from 'node:assert/strict';
import { twinRpc } from '../src/db/twin-client.js';
import {
  parseCallResult,
  rpcInputs,
  type RpcName,
  type RpcArgs,
} from '../src/db/rpc-contracts/index.js';
import type { DatabaseRpc } from '../src/db/generated/database.js';
import type { CallSession } from '@carrier/contracts/calls';

type Assert<T extends true> = T;
type KeyMatch<K extends RpcName> =
  Exclude<keyof RpcArgs<K>, keyof DatabaseRpc[K]['Args']> extends never
    ? Exclude<keyof DatabaseRpc[K]['Args'], keyof RpcArgs<K>> extends never
      ? true
      : false
    : false;
export type GeneratedSignatureCheck = Assert<{ [K in RpcName]: KeyMatch<K> }[RpcName]>;
const session: CallSession = {
  callId: '11111111-1111-4111-8111-111111111111',
  check: null,
  authorityRevision: 0,
  availableLoadIds: [],
  selectedLoadId: null,
  voiceState: 'idle',
  voiceRunId: null,
  expiresAt: '2026-09-06T12:00:00Z',
  otpState: 'not_sent',
  challengeId: null,
  otpFailuresRemaining: 2,
  otpRetryAllowed: true,
  verified: false,
  demo: true,
};

test('Twin rejects malformed nested sessions and incomplete successful RPC responses', () => {
  for (const patch of [
    { verified: 'false' },
    { availableLoadIds: {} },
    { otpFailuresRemaining: 99 },
    { check: { eligible: true } },
    { booking: { status: 'confirmed' } },
  ])
    assert.throws(() =>
      parseCallResult(
        'poc_start_call',
        { p_id: session.callId, p_session_hash: 'hash' },
        { ok: true, session: { ...session, ...patch } },
      ),
    );
  assert.throws(() =>
    parseCallResult(
      'poc_negotiate',
      { p_session_hash: 'hash', p_action: 'accept', p_load_id: 'L1' },
      { ok: true },
    ),
  );
  assert.throws(() =>
    parseCallResult('poc_resolve_voice', { p_run_id: session.callId }, { ok: true }),
  );
});
test('Twin projects private fields out of sessions and ordinary call results', () => {
  const result = parseCallResult(
    'poc_call_action',
    { p_session_hash: 'hash', p_action: 'status' },
    {
      ok: true,
      privateTopLevel: 'secret',
      verifier: 'a'.repeat(64),
      sessionHash: 'b'.repeat(64),
      session: { ...session, otp_digest: 'secret', booking_terms: { MAX_BUY: 9999 } },
    },
  );
  assert.deepEqual(result, { ok: true, session });
  const internal = parseCallResult(
    'poc_call_action',
    { p_session_hash: 'hash', p_action: 'prepare_verify' },
    { ok: true, verifier: 'a'.repeat(64) },
  );
  assert.equal(internal.verifier, 'a'.repeat(64));
});
test('Twin rejects misspelled action names and unexpected arguments before HTTP', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw Error('unexpected network');
  });
  assert.equal(
    rpcInputs.poc_book_call.safeParse({ p_session_hash: 'hash', p_action: 'book' }).success,
    false,
  );
  // Compile-time regression: names and arguments are tied to their SQL function.
  await assert.rejects(
    // @ts-expect-error p_session_hash is required by the generated start signature.
    twinRpc('poc_start_call', { p_id: session.callId }),
    /TWIN_INVALID_ARGUMENTS/,
  );
  assert.equal(calls, 0);
});
