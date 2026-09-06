import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  parseCallResult,
  rpcInputs,
  operatorResults,
  type CallRpcRequest,
} from '../../src/db/rpc-contracts/index.js';

// Exercise the actual migrated functions and validate their returned JSON, not
// TypeScript-shaped fixtures. This database is owned by schema.mjs and discarded.
export async function verifyRpcContracts(sql: (source: string) => Promise<string>) {
  const literal = (v: unknown): string =>
    v === null
      ? 'NULL'
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : `'${(typeof v === 'object' ? JSON.stringify(v) : String(v)).replaceAll("'", "''")}'${typeof v === 'object' ? '::jsonb' : ''}`;
  const raw = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(
      await sql(
        `SELECT public.${name}(${Object.entries(args)
          .map(([k, v]) => `${k}=>${literal(v)}`)
          .join(',')});`,
      ),
    ) as unknown;
  const rpc = async (...[name, args]: CallRpcRequest) => {
    rpcInputs[name].parse(args);
    const result = parseCallResult(name, args, await raw(name, args));
    assert.equal(result.ok, true, `${name}: ${result.error}`);
    return result;
  };
  const id = randomUUID(),
    hash = randomBytes(32).toString('hex'),
    challenge = randomUUID(),
    run = randomUUID();
  await rpc('poc_start_call', { p_id: id, p_session_hash: hash });
  const action = async (
    p_action: typeof rpcInputs.poc_call_action._output.p_action,
    extra: Record<string, unknown> = {},
  ) => rpc('poc_call_action', { p_session_hash: hash, p_action, ...extra });
  await action('authority_begin', { p_metadata: { mcNumber: '1515' } });
  await action('authority_complete', {
    p_metadata: {
      revision: 1,
      check: {
        mcNumber: '1515',
        eligible: true,
        outcome: 'eligible',
        reason: 'ACTIVE_CARRIER_AUTHORITY',
        checkedAt: new Date().toISOString(),
      },
    },
  });
  await action('voice_reserve');
  await action('voice_bind', { p_metadata: { runId: run } });
  const resolved = await rpc('poc_resolve_voice', { p_run_id: run });
  assert.equal(resolved.sessionHash, hash);
  await action('issue', { p_challenge: challenge, p_digest: 'a'.repeat(64), p_recipient: 'test' });
  await action('sent', { p_challenge: challenge });
  const prepared = await action('prepare_verify', { p_challenge: challenge });
  assert.equal(prepared.verifier, 'a'.repeat(64));
  await action('verify', { p_challenge: challenge, p_matches: true });
  await action('authorize_load', { p_metadata: { command: 'LOAD_QUERY' } });
  await action('save_loads', {
    p_metadata: {
      command: 'LOAD_QUERY',
      revision: 1,
      ok: true,
      loadIds: ['C1', 'P1'],
      loadStatuses: { C1: 'OPEN', P1: 'PENDING' },
    },
  });
  await rpc('poc_record_load_interest', {
    p_session_hash: hash,
    p_load_id: 'P1',
    p_callback_number: '+12125550123',
    p_consent: true,
    p_revision: 1,
  });
  await action('authorize_load', { p_metadata: { command: 'LOAD_GET', loadId: 'C1' } });
  await action('save_loads', {
    p_metadata: {
      command: 'LOAD_GET',
      loadId: 'C1',
      revision: 1,
      ok: true,
      loadIds: ['C1'],
      loadStatuses: { C1: 'OPEN' },
    },
  });
  const offer = await rpc('poc_negotiate', {
    p_session_hash: hash,
    p_action: 'quote',
    p_load_id: 'C1',
    p_revision: 1,
    p_listed_cents: 100000,
    p_max_cents: 120000,
  });
  const offerId = offer.negotiation?.offer_id;
  assert.ok(offerId);
  const terms = { LOAD_ID: 'C1', STATUS: 'OPEN', RATE: '1000', EQTYPE: 'FLATBED' };
  const booking = { loadId: 'C1', offerId, terms };
  await rpc('poc_book_call', { p_session_hash: hash, p_action: 'quote', p_metadata: booking });
  const accepted = await rpc('poc_negotiate', {
    p_session_hash: hash,
    p_action: 'accept',
    p_load_id: 'C1',
    p_offer_id: offerId,
  });
  assert.ok(accepted.negotiation?.offer_id);
  booking.offerId = accepted.negotiation.offer_id;
  await rpc('poc_book_call', { p_session_hash: hash, p_action: 'prepare', p_metadata: booking });
  const attemptId = randomUUID();
  await rpc('poc_book_call', {
    p_session_hash: hash,
    p_action: 'claim',
    p_metadata: { ...booking, attemptId, simulated: true, listedCents: 100000, maxCents: 120000 },
  });
  await rpc('poc_book_call', {
    p_session_hash: hash,
    p_action: 'complete',
    p_metadata: {
      attemptId,
      result: {
        status: 'confirmed',
        reference: 'MOCK-CONTRACT',
        timestamp: '20260906120000',
        simulated: true,
      },
    },
  });
  const finalized = await rpc('poc_finalize_call', {
    p_session_hash: hash,
    p_outcome: 'conversation_complete',
    p_summary: 'Contract verification completed.',
  });
  assert.equal(finalized.session?.finalOutcome, 'booking_simulated');
  await sql(
    "INSERT INTO poc_private.operator_access VALUES(encode(sha256(convert_to('contract-key','UTF8')),'hex'));",
  );
  const list = operatorResults.list.parse(
    await raw('poc_operator', { p_key: 'contract-key', p_action: 'list' }),
  );
  assert.ok(list.calls.some((c) => c.id === id));
  const detail = operatorResults.detail.parse(
    await raw('poc_operator', {
      p_key: 'contract-key',
      p_action: 'detail',
      p_metadata: { call_id: id },
    }),
  );
  assert.ok(detail.call);
  assert.ok(detail.events.length > 0);
  assert.equal(JSON.stringify(detail).includes(hash), false);
  const review = detail.call.reviews[0];
  assert.ok(review);
  operatorResults.review.parse(
    await raw('poc_operator', {
      p_key: 'contract-key',
      p_action: 'review',
      p_metadata: {
        id: review.id,
        revision: review.revision,
        status: 'reviewed',
        note: 'Contract verified.',
      },
    }),
  );
  console.log(
    'Passed RPC contracts against real PostgreSQL session, OTP, voice, interest, negotiation, booking and operator results.',
  );
}
