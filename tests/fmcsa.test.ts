import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FmcsaError, lookupCarrier, normalizeMc, parseCarrierCheck } from '../src/fmcsa';

// Synthetic contract fixtures only. The application never uses these as fallback data.
const carrier = { dotNumber: 123, legalName: 'Test Carrier', allowedToOperate: 'Y', outOfService: 'N', commonAuthorityStatus: 'A', contractAuthorityStatus: 'N' };
const payload = (changes = {}) => ({ content: [{ carrier: { ...carrier, ...changes } }] });
const previous = process.env.FMCSA_API_KEY;
before(() => { process.env.FMCSA_API_KEY = 'fixture-secret'; });
after(() => { if (previous === undefined) delete process.env.FMCSA_API_KEY; else process.env.FMCSA_API_KEY = previous; });
const jsonFetch = (data: unknown): typeof fetch => async () => Response.json(data);

test('normalizes MC formats and rejects arbitrary URLs and malformed input', () => {
  for (const mc of ['1515', ' MC-001515 ', 'mc 1515']) assert.equal(normalizeMc(mc), '1515');
  for (const mc of ['', '0', 'MC123abc', '12/34', 'https://evil.example', 1515, '123456789']) assert.throws(() => normalizeMc(mc));
});
test('explicit active common or contract authority passes with operation and OOS flags', () => {
  assert.equal(parseCarrierCheck(payload(), '1515').outcome, 'eligible');
  assert.equal(parseCarrierCheck(payload({ commonAuthorityStatus: 'N', contractAuthorityStatus: 'A' }), '1515').eligible, true);
  assert.equal(parseCarrierCheck({ content: { carrier: { ...carrier, allowedToOperate: undefined, allowToOperate: 'Y' } } }, '1515').eligible, true);
});
test('inactive, out-of-service and broker-only carriers cannot pass', () => {
  for (const fields of [{ allowedToOperate: 'N' }, { allowedToOperate: 'N', outOfService: 'Y' }, { commonAuthorityStatus: 'I' }, { commonAuthorityStatus: 'N', brokerAuthorityStatus: 'A' }]) {
    const result = parseCarrierCheck(payload(fields), '1515');
    assert.equal(result.outcome, 'ineligible'); assert.equal(result.eligible, false);
  }
});
test('unknown flags, missing flags and contradictory allowed flags fail closed', () => {
  for (const fields of [{ outOfService: null }, { outOfService: '?' }, { allowedToOperate: undefined }, { commonAuthorityStatus: '?' }, { allowToOperate: 'N' }]) {
    const result = parseCarrierCheck(payload(fields), '1515');
    assert.equal(result.outcome, 'unverified'); assert.equal(result.eligible, false);
  }
});
test('the observed live response passes without an optional out-of-service field', () => {
  // Public authority subset observed from MC 133654 on 2026-09-05.
  const liveShape = { content: [{ carrier: {
    dotNumber: 1078021, legalName: 'LESTER MOVING & STORAGE COMPANY',
    allowedToOperate: 'Y', commonAuthorityStatus: 'A', contractAuthorityStatus: 'N',
    oosDate: null, statusCode: 'A',
  } }] };
  const result = parseCarrierCheck(liveShape, '133654');
  assert.equal(result.outcome, 'eligible');
  assert.equal(result.carrier?.outOfService, null);
  assert.equal(result.carrier?.outOfServiceReported, false);
  // Omitting OOS does not substitute for required permission or active authority.
  assert.equal(parseCarrierCheck(payload({ outOfService: undefined, allowedToOperate: undefined }), '1515').outcome, 'unverified');
  assert.equal(parseCarrierCheck(payload({ outOfService: undefined, commonAuthorityStatus: 'N' }), '1515').outcome, 'ineligible');
});
test('explicit conflicting restrictions and permission aliases cannot pass', () => {
  for (const fields of [{ outOfService: 'Y' }, { allowToOperate: 'N' }]) {
    const result = parseCarrierCheck(payload(fields), '1515');
    assert.equal(result.outcome, 'unverified');
    assert.equal(result.reason, 'CONFLICTING_AUTHORITY_DATA');
    assert.equal(result.eligible, false);
  }
});
test('distinguishes confirmed empty data, ambiguous carriers and malformed responses', () => {
  assert.equal(parseCarrierCheck({ content: [] }, '1515').outcome, 'not_found');
  assert.equal(parseCarrierCheck({ content: [{ carrier }, { carrier }] }, '1515').outcome, 'unverified');
  for (const value of [null, {}, { content: null }, { content: [{}] }, payload({ dotNumber: null })]) assert.throws(() => parseCarrierCheck(value, '1515'));
});
test('returns only safe carrier fields', () => {
  const result = parseCarrierCheck(payload({ phone: 'private', ein: 'private', links: [{ href: 'secret-url' }] }), '1515');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!JSON.stringify(result).includes('secret-url'));
});
test('uses fixed official URL, server key, no cache, deadline and no redirects', async () => {
  let calls = 0;
  const result = await lookupCarrier('MC-1515', undefined, async (input, init) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.origin, 'https://mobile.fmcsa.dot.gov');
    assert.equal(url.pathname, '/qc/services/carriers/docket-number/1515/');
    assert.equal(url.searchParams.get('webKey'), 'fixture-secret');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store'); assert.ok(init?.signal);
    return Response.json(payload());
  });
  assert.equal(calls, 1); assert.equal(result.eligible, true);
});
test('handles auth denial, throttling, upstream failure and invalid JSON without leaking details', async () => {
  for (const [status, code] of [[401, 'FMCSA_ACCESS_DENIED'], [403, 'FMCSA_ACCESS_DENIED'], [429, 'FMCSA_RATE_LIMITED'], [500, 'FMCSA_UNAVAILABLE'], [404, 'FMCSA_UNAVAILABLE']] as const) {
    await assert.rejects(lookupCarrier('1515', undefined, async () => new Response('fixture-secret', { status })), (e: unknown) => e instanceof FmcsaError && e.code === code && !e.message.includes('fixture-secret'));
  }
  await assert.rejects(lookupCarrier('1515', undefined, async () => new Response('<html>bad</html>')), { code: 'FMCSA_INVALID_RESPONSE' });
  await assert.rejects(lookupCarrier('1515', undefined, async () => { throw new Error('https://upstream?webKey=fixture-secret'); }), { message: 'FMCSA_UNAVAILABLE' });
  await assert.rejects(lookupCarrier('1515', undefined, jsonFetch({ content: null })), { code: 'FMCSA_INVALID_RESPONSE' });
});
test('rejects oversized responses', async () => {
  await assert.rejects(lookupCarrier('1515', undefined, async () => new Response('x'.repeat(256 * 1024 + 1))), { code: 'FMCSA_INVALID_RESPONSE' });
});
test('propagates cancellation and classifies deadline errors', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(lookupCarrier('1515', controller.signal, async (_url, init) => { init?.signal?.throwIfAborted(); return Response.json(payload()); }), { code: 'CANCELLED' });
  await assert.rejects(lookupCarrier('1515', undefined, async () => { throw new DOMException('deadline', 'TimeoutError'); }), { code: 'FMCSA_TIMEOUT', status: 504 });
});
test('missing configuration fails without contacting FMCSA', async () => {
  delete process.env.FMCSA_API_KEY;
  try { await assert.rejects(lookupCarrier('1515', undefined, async () => { assert.fail('Must not fetch'); }), { code: 'FMCSA_NOT_CONFIGURED' }); }
  finally { process.env.FMCSA_API_KEY = 'fixture-secret'; }
});
