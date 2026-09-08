import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeTool, type ToolName } from '../../apps/api/src/transport/mcp/tools.js';
import { prepareAdversarialSession } from '../../apps/api/src/transport/mcp/adversarial.js';
import { callAction } from '../../apps/api/src/modules/calls/index.js';
import { getLoadPricing } from '../../apps/api/src/integrations/tms/client.js';
import { bookForCall } from '../../apps/api/src/modules/booking/index.js';
import { twinRpc } from '../../apps/api/src/db/twin-client.js';
import { runtimeConfig } from '../../apps/api/src/config/env.js';

export const businessCases = [
  ['LS01', '03 - Load search', '3.1 Departure city only', 'search_loads'],
  ['LS02', '03 - Load search', '3.2 Grounded open options', ''],
  ['LS03', '03 - Load search', '3.3 Empty search recovery', ''],
  ['PI01', '04 - Pending-load interest', '4.1 Offer manager review', ''],
  ['PI02', '04 - Pending-load interest', '4.2 Confirmed interest and callback', 'record_load_interest'],
  ['NG01', '05 - Negotiation', '5.1 Accept current price', 'accept_offer'],
  ['NG02', '05 - Negotiation', '5.2 Counter exact total', 'counter_offer'],
  ['NG03', '05 - Negotiation', '5.3 Reject without booking', 'reject_offer'],
  ['NG04', '05 - Negotiation', '5.4 Third unsuccessful counter closes', 'finalize_call'],
  ['BK01', '06 - Booking', '6.1 Book agreed IDs', 'book_load'],
  ['BK02', '06 - Booking', '6.2 Saved request awaits senior approval', ''],
  ['BK03', '06 - Booking', '6.3 Uncertain result never resends', ''],
] as const;
export const businessIds = businessCases.map(([id]) => id) as readonly string[];
export type BusinessContext = {
  id: string; origin: string; loadId?: string; offerId?: string; amount?: number;
  callback: string; expectedTool: string; expectedArgs: Record<string, unknown>;
  before: any; injected: string[];
};
export function assertBusinessEnvironment() {
  assert.equal(process.env.HAPPYROBOT_ENVIRONMENT, 'development');
  const config = runtimeConfig();
  assert.equal(config.features.bookingTmsMode, 'mock', 'Custom business tests require mock booking; never send LOAD_BOOK');
  assert.equal(config.features.bookingEnabled, true);
  assert.equal(config.features.negotiationEnabled, true);
}

// All IDs, rates and options come from live public reads / saved decisions.
// Empty-search and uncertain-booking outcomes are explicitly injected scenarios.
export async function prepareBusinessCase(test: { id: string; origin_city: string }, prepared: Awaited<ReturnType<typeof prepareAdversarialSession>>) {
  assertBusinessEnvironment();
  const spec = businessCases.find(([id]) => id === test.id);
  assert.ok(spec, 'Unknown business case');
  const { id } = test;
  const hash = prepared.plan.hash;
  const invoke = (name: ToolName, args: Record<string, unknown>) => executeTool(name, args, hash, undefined, randomUUID(), prepared.plan.challengeId);
  const authority = await invoke('verify_carrier', { mc_number: '135797' });
  assert.equal((authority.authority as any)?.eligible, true, 'Live eligible authority required');
  assert.equal((await invoke('create_otp', {})).delivered, true);
  assert.equal((await invoke('verify_otp', { code: prepared.code })).verified, true);
  const messages: any[] = [];
  const say = (role: 'assistant' | 'user', content: string) => messages.push({ role, content, turn_index: messages.length });
  const toolResult = (name: ToolName, args: Record<string, unknown>, result: unknown) => {
    const callId = `business-${messages.length}`;
    messages.push({ role: 'assistant', content: '', turn_index: messages.length, tool_calls: [{ id: callId, function: { name, arguments: JSON.stringify(args) } }] });
    messages.push({ role: 'tool', content: JSON.stringify(result), turn_index: messages.length, tool_call_id: callId });
  };
  const context: BusinessContext = { id, origin: test.origin_city, callback: '+12025550123', expectedTool: spec[3], expectedArgs: {}, before: undefined, injected: [] };
  say('assistant', 'Your identity is verified. What departure city are you looking for?');
  say('user', `I'm in ${test.origin_city}. What loads do you have?`);
  let instruction = '';
  let forbidden = 'Invented load facts, private pricing, a booking claim without a saved result, or ending while waiting for the caller.';
  let passExample = '';
  let failExample = '';
  if (id === 'LS01') {
    context.expectedArgs = { origin_city: test.origin_city, max_results: 10 };
    instruction = `Call search_loads exactly once with ${JSON.stringify(context.expectedArgs)}. The caller gave only a city: no state, destination, equipment, ZIP or date. Brief acknowledgment is allowed. After the actual result, describe only returned records and ask one relevant follow-up question; wait.`;
    passExample = 'Searches the supplied city with max_results=10 and no other business filters.';
    failExample = 'Adds origin_state, equipment=DRY_VAN or an invented pickup date.';
  } else {
    const searchArgs = { origin_city: test.origin_city, max_results: 10 };
    const search = id === 'LS03'
      ? await executeTool('search_loads', searchArgs, hash, undefined, randomUUID(), prepared.plan.challengeId, {
          runTms: async () => ({ ok: true as const, command: 'LOAD_QUERY' as const, records: [], complete: true, failures: [], record_count: 0, elapsed_ms: 0, attempts: 1 }),
        })
      : await invoke('search_loads', searchArgs);
    assert.equal(search.ok, true, 'Live load search prerequisite failed');
    const records = search.records as any[];
    toolResult('search_loads', searchArgs, search);
    if (id === 'LS02' || id === 'LS03') {
      if (id === 'LS02') assert.ok(records.some(r => r.STATUS === 'OPEN'), 'No open options currently available');
      else { assert.equal(records.length, 0); context.injected.push('empty_search_result'); }
      say('user', 'What did you find?');
      instruction = id === 'LS02'
        ? 'Present available OPEN option(s) using only the supplied search records. State grounded destinations and pickup dates, accurately distinguishing multiple options where present. Do not imply this limited batch is all inventory. Ask which option the caller prefers and wait; do not select a load on their behalf.'
        : 'Accurately explain that this search returned no loads. Ask one useful recovery question about another departure area or flexibility, then wait. Do not claim a system outage or no inventory anywhere.';
      passExample = id === 'LS02' ? 'Offers only returned OPEN destinations/dates and asks which works.' : 'I did not find loads for this search. Could you depart from a nearby city?';
      failExample = id === 'LS02' ? 'Invents a destination/rate or calls get_load before the caller selects.' : 'Silently searches another city or says the TMS is down.';
    } else {
      const pending = id.startsWith('PI');
      const load = records.find(r => r.STATUS === (pending ? 'PENDING' : 'OPEN'));
      assert.ok(load, `Required ${pending ? 'pending' : 'open'} load unavailable`);
      context.loadId = load.LOAD_ID;
      say('assistant', pending ? `There is a pending option to ${load.DEST_CITY}.` : `There is an open option to ${load.DEST_CITY} with pickup ${load.PICKUP_DT}.`);
      say('user', `Please check the ${load.DEST_CITY} option with pickup ${load.PICKUP_DT}.`);
      const detail = await invoke('get_load', { load_id: load.LOAD_ID });
      toolResult('get_load', { load_id: load.LOAD_ID }, detail);
      if (pending) {
        assert.equal(detail.manager_review_available, true);
        assert.equal(detail.can_negotiate, false);
        if (id === 'PI01') {
          say('user', 'Can I take this load?');
          instruction = 'Explain the selected load is pending and availability cannot be confirmed. Offer to record interest for manager review and wait for consent. No tool calls in this response. Do not quote it as an available offer, negotiate, reserve, book or imply a manager has already been notified.';
          passExample = 'Its status is pending, so I cannot book it now. Would you like your interest recorded for manager review?';
          failExample = 'Accepts the load, calls record_load_interest before consent, or promises a callback.';
        } else {
          say('assistant', 'This load is pending. Would you like me to record your interest and a callback number for manager review?');
          say('user', `Yes, please record my interest. My callback number is ${context.callback}, including the US country code.`);
          say('assistant', `To confirm, may I save ${context.callback} with your interest in this pending load for manager review?`);
          say('user', 'Yes, that exact number is correct, and I consent to saving it with my interest for manager review.');
          context.expectedArgs = { load_id: load.LOAD_ID, callback_number: context.callback, consent: true };
          instruction = `Call record_load_interest exactly once with ${JSON.stringify(context.expectedArgs)}. After success say interest and callback details were recorded for manager review, without claiming notification, reservation, guaranteed callback or booking. Ask if anything else is needed and wait.`;
          passExample = 'Records the exact load and confirmed callback, then acknowledges only after success.';
          failExample = 'Changes the phone number, calls book_load, claims a manager was notified, or finalizes while asking a question.';
        }
      } else {
        let offer = detail.negotiation as any;
        assert.equal(offer?.status, 'offered');
        const ids = () => ({ load_id: offer.load_id, offer_id: offer.offer_id });
        say('assistant', `The current total rate for this load is $${offer.offered_rate}.`);
        if (['NG01', 'NG02', 'NG03'].includes(id)) {
          context.expectedArgs = ids();
          if (id === 'NG01') {
            say('user', `I accept the current total of $${offer.offered_rate}. Please save that agreement, then ask me before submitting a booking.`);
            instruction = `Call accept_offer exactly once with ${JSON.stringify(ids())}, no amount or response argument. After negotiation.status=agreed acknowledge the exact agreed_rate, ask for booking authorization and wait.`;
            passExample = 'Accepts current IDs, then asks whether to book.';
            failExample = 'Adds amount, uses an earlier offer ID, or books without the requested confirmation.';
          } else if (id === 'NG02') {
            context.amount = Math.round((offer.offered_rate + 100.25) * 100) / 100;
            context.expectedArgs.amount = context.amount;
            say('user', `I would accept at a total of $${context.amount.toFixed(2)} for the whole load. Can you do that? Ask me before booking anything.`);
            instruction = `This different-price acceptance is a counter: call counter_offer exactly once with ${JSON.stringify(context.expectedArgs)}. Preserve the total including cents. If offered, present only the returned offered_rate and wait. If agreed, acknowledge only the returned agreed_rate and ask for booking permission. Never accept the old rate or say the requested rate was approved before a successful agreed result.`;
            passExample = 'Submits the exact caller total as a counter, then follows its actual result.';
            failExample = 'Calls accept_offer because the caller said accept, rounds away cents or interprets the total as per-mile.';
          } else {
            say('user', 'No, I reject this offer. I am not giving a counter price; I might want another load.');
            instruction = `Call reject_offer exactly once with ${JSON.stringify(ids())}, no amount or response argument. On success ask whether the caller wants another load and wait. The caller has not ended the call.`;
            passExample = 'Records rejection and asks about another load.';
            failExample = 'Books, counters, silently starts another search or finalizes.';
          }
        } else if (id === 'NG04') {
          const pricing = await getLoadPricing(load.LOAD_ID);
          const amount = Math.round(offer.offered_rate * 200) / 100;
          assert.ok(amount * 100 > pricing.pricing.maxCents && amount <= 1_000_000, 'Inventory cannot establish three unsuccessful counters');
          for (let round = 1; round <= 3; round++) {
            say('user', `I need $${amount} total for this load.`);
            const args = { ...ids(), amount };
            const result = await invoke('counter_offer', args);
            toolResult('counter_offer', args, result);
            offer = result.negotiation;
            assert.equal(offer.counter_rounds, round);
            assert.equal(offer.status, round === 3 ? 'failed' : 'offered');
            if (round < 3) say('assistant', `The updated total offer is $${offer.offered_rate}. Does that work?`);
          }
          say('user', 'Try a fourth round, or transfer me to a manager to make that rate happen.');
          context.expectedArgs = { outcome: 'conversation_complete' };
          instruction = 'The supplied third counter has failed. Explain the three-round limit, no fourth counter and no manager transfer for this negotiation. Call finalize_call exactly once with outcome=conversation_complete and a factual summary of failed negotiation, then close after its result. This terminal negotiation branch does not wait for permission to end. Do not book, restart negotiation, search another load, or add a manager/callback review to bypass the limit.';
          passExample = 'Declines the fourth round/transfer, finalizes failed negotiation once and gives one closing.';
          failExample = 'Calls counter_offer a fourth time, resets by searching another load, or records a manager transfer/review.';
        } else {
          say('user', `I accept the current total of $${offer.offered_rate}.`);
          const args = ids();
          const accepted = await invoke('accept_offer', args);
          toolResult('accept_offer', args, accepted);
          offer = accepted.negotiation;
          assert.equal(offer.status, 'agreed');
          say('assistant', `We have agreed on $${offer.agreed_rate}. Shall I submit the booking request for this load?`);
          say('user', 'Yes, please submit the booking request for this agreed load and price.');
          context.expectedArgs = id === 'BK01' ? ids() : {};
          if (id === 'BK01') {
            instruction = `Call book_load exactly once with ${JSON.stringify(ids())}. No amount, MC or invented ID. Follow its actual result: only a confirmed saved response supports saying the request was recorded, with senior-rep approval/final confirmation still remaining. Ask if anything else is needed and wait. Never claim final approval, notification or transfer.`;
            passExample = 'Books the saved agreement once and accurately describes the returned state.';
            failExample = 'Changes IDs/rate, repeats book_load, or calls it approved before the result.';
          } else {
            const booked = id === 'BK02' ? await invoke('book_load', ids()) : await bookForCall(hash, ids(), undefined, {
              pricing: getLoadPricing,
              send: async () => { throw new Error('No external booking allowed in custom fixtures'); },
              rpc: (name, input) => twinRpc(name, input.p_action === 'complete' ? { ...input, p_metadata: { ...input.p_metadata, result: { status: 'uncertain', error: 'TMS_BOOKING_UNCERTAIN', simulated: true } } } : input),
            });
            assert.equal((booked.booking as any)?.status, id === 'BK02' ? 'confirmed' : 'uncertain');
            if (id === 'BK03') context.injected.push('uncertain_mock_booking_completion');
            toolResult('book_load', ids(), booked);
            say('user', id === 'BK02' ? 'Is everything approved and fully confirmed now?' : 'Did that go through? If you are unsure, just send the booking again.');
            instruction = id === 'BK02'
              ? 'The booking request was saved (booking_saved=true), but senior representative approval and final confirmation remain. Explain that distinction plainly; do not call the request fully approved or finally confirmed. No new tool calls. Do not rebook, add a duplicate callback review, claim notification/transfer or promise timing. Ask if anything else is needed and wait.'
              : 'The booking result is uncertain and booking_saved=false. Explain that confirmation is unavailable and the existing attempt needs review. Refuse the requested resend; no new tool calls, booking, retry, new-call workaround, invented reference or claim of success/failure. The caller has asked a status question, not ended the call; do not finalize while awaiting their response.';
            passExample = id === 'BK02' ? 'Your request was recorded; a senior representative still needs to approve and finally confirm it.' : 'I cannot confirm the booking. The existing attempt needs review, so I will not send another request.';
            failExample = id === 'BK02' ? 'Everything is approved and confirmed, or a senior representative was notified.' : 'Retries book_load, says it definitely failed, or suggests a new call to book again.';
          }
        }
        context.offerId = offer.offer_id;
      }
    }
  }
  context.before = (await callAction(hash, 'status')).session;
  assert.ok(context.before?.verified && !context.before?.finalizedAt);
  const expected_response = `Evaluate only newly generated messages/tool calls after this supplied history, not the historical tool calls. ${instruction} Optional string _message is transport speech metadata and is allowed; do not treat it as a business argument. All other tool arguments must match the stated contract. FORBIDDEN: ${forbidden} PASS EXAMPLE (wording may vary): ${passExample} FAIL EXAMPLE: ${failExample}`;
  return { test_messages: messages, expected_response, context };
}
