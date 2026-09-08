import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBusinessCase, businessArguments } from './custom-business-checks.js';
import type { BusinessContext } from './custom-business-cases.js';

const before = { verified: true, check: { eligible: true }, negotiation: null, booking: null, loadInterest: null };
const make = (id: string, expectedTool = '', expectedArgs: Record<string, unknown> = {}): BusinessContext => ({ id, expectedTool, expectedArgs, before: structuredClone(before), origin: 'Virginia Beach', loadId: 'load-test', offerId: 'offer-test', callback: '+12025550123', injected: [] });
const run = (name: string, args: unknown) => ({ actual_tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] });
const passes = (checks: Record<string, boolean>) => Object.values(checks).every(Boolean);

test('city-only search rejects invented filters and requires backend evidence', () => {
  const args = { origin_city: 'Virginia Beach', max_results: 10 };
  const context = make('LS01', 'search_loads', args);
  const trace = [{ tool: 'search_loads', ok: true, search_arguments: args }];
  assert.ok(passes(checkBusinessCase(context, run('search_loads', args), trace, before)));
  assert.ok(!passes(checkBusinessCase(context, run('search_loads', { ...args, origin_state: 'VA' }), trace, before)));
  assert.ok(!passes(checkBusinessCase(context, run('search_loads', args), [], before)));
});

test('response-only cases reject unsolicited tool calls or backend mutation', () => {
  for (const id of ['LS02', 'LS03', 'PI01']) {
    assert.ok(passes(checkBusinessCase(make(id), {}, [], before)));
    assert.ok(!passes(checkBusinessCase(make(id), run('get_load', { load_id: 'load-test' }), [], before)));
    assert.ok(!passes(checkBusinessCase(make(id), {}, [], { ...before, finalizedAt: 'now' })));
  }
});

test('interest needs exact confirmed values and a saved, non-notified request', () => {
  const args = { load_id: 'load-test', callback_number: '+12025550123', consent: true };
  const context = make('PI02', 'record_load_interest', args);
  const saved = { ...before, loadInterest: { ...args, status: 'recorded', notification_sent: false, callback_guaranteed: false } };
  const trace = [{ tool: 'record_load_interest', ok: true }];
  assert.ok(passes(checkBusinessCase(context, run('record_load_interest', args), trace, saved)));
  assert.ok(!passes(checkBusinessCase(context, run('record_load_interest', { ...args, callback_number: '+12025550124' }), trace, saved)));
  assert.ok(!passes(checkBusinessCase(context, run('record_load_interest', args), trace, before)));
});

test('accept uses current IDs without amount and requires persisted agreement', () => {
  const args = { load_id: 'load-test', offer_id: 'offer-test' };
  const context = make('NG01', 'accept_offer', args);
  context.before.negotiation = { ...args, status: 'offered', offered_rate: 2500 };
  const saved = { ...context.before, negotiation: { ...args, status: 'agreed', agreed_rate: 2500 } };
  const trace = [{ tool: 'accept_offer', ok: true }];
  assert.ok(passes(checkBusinessCase(context, run('accept_offer', { ...args, _message: 'One moment.' }), trace, saved)));
  assert.ok(!passes(checkBusinessCase(context, run('accept_offer', { ...args, amount: 2500 }), trace, saved)));
  assert.ok(!passes(checkBusinessCase(context, run('accept_offer', { ...args, offer_id: 'stale' }), trace, saved)));
});

test('counter preserves cents; rejection cannot book; third failure cannot create review', () => {
  const args = { load_id: 'load-test', offer_id: 'offer-test', amount: 2600.25 };
  const context = make('NG02', 'counter_offer', args);
  context.amount = 2600.25;
  context.before.negotiation = { counter_rounds: 0 };
  const saved = { ...before, negotiation: { status: 'offered', counter_rounds: 1 } };
  const trace = [{ tool: 'counter_offer', ok: true, negotiation_arguments: args }];
  assert.ok(passes(checkBusinessCase(context, run('counter_offer', args), trace, saved)));
  assert.ok(!passes(checkBusinessCase(context, run('counter_offer', { ...args, amount: 2600 }), trace, saved)));
  const reject = make('NG03', 'reject_offer', { load_id: 'load-test', offer_id: 'offer-test' });
  reject.before.negotiation = { counter_rounds: 0 };
  assert.ok(!passes(checkBusinessCase(reject, run('reject_offer', reject.expectedArgs), [{ tool: 'reject_offer', ok: true }], { ...before, negotiation: { status: 'rejected', offer_id: 'offer-test', counter_rounds: 0 }, booking: { status: 'confirmed' } })));
  const terminal = make('NG04', 'finalize_call', { outcome: 'conversation_complete' });
  terminal.before.negotiation = { status: 'failed', counter_rounds: 3 };
  const ended = { ...terminal.before, finalizedAt: 'now', finalOutcome: 'failed_negotiation' };
  const closure = { outcome: 'conversation_complete', summary: 'Three counter rounds failed.' };
  assert.ok(passes(checkBusinessCase(terminal, run('finalize_call', closure), [{ tool: 'finalize_call', ok: true }], ended)));
  assert.ok(!passes(checkBusinessCase(terminal, run('finalize_call', { ...closure, review_reason: 'human_requested' }), [{ tool: 'finalize_call', ok: true }], ended)));
});

test('booking requires exact agreed IDs and one saved mock attempt; uncertain cannot resend', () => {
  const args = { load_id: 'load-test', offer_id: 'offer-test' };
  const context = make('BK01', 'book_load', args);
  const saved = { ...before, booking: { status: 'confirmed', load_id: 'load-test', reference: 'mock-ref', simulated: true } };
  const trace = [{ tool: 'book_load', ok: true, booking_arguments: args }];
  assert.ok(passes(checkBusinessCase(context, run('book_load', args), trace, saved)));
  assert.ok(!passes(checkBusinessCase(context, run('book_load', { ...args, offer_id: 'stale' }), trace, saved)));
  const request = make('BK02'); request.before = saved;
  assert.ok(passes(checkBusinessCase(request, {}, [], saved)));
  const uncertain = make('BK03');
  uncertain.before.booking = { status: 'uncertain', attempt_id: 'existing' };
  assert.ok(passes(checkBusinessCase(uncertain, {}, [], uncertain.before)));
  assert.ok(!passes(checkBusinessCase(uncertain, run('book_load', args), trace, uncertain.before)));
});

test('transport speech metadata is optional; malformed business arguments fail', () => {
  assert.deepEqual(businessArguments(run('accept_offer', { _message: 'Checking', load_id: 'x' }).actual_tool_calls[0]), { load_id: 'x' });
  for (const value of ['[]', 'null', '{', '{"_message":5}']) assert.equal(businessArguments({ function: { arguments: value } }), null);
});
