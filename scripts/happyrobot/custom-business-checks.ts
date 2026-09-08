import { isDeepStrictEqual } from 'node:util';
import type { BusinessContext } from './custom-business-cases.js';

export function businessArguments(call: any): Record<string, unknown> | null {
  try {
    const args = JSON.parse(call?.function?.arguments ?? '{}');
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    if ('_message' in args && typeof args._message !== 'string') return null;
    const { _message, ...business } = args;
    return business;
  } catch { return null; }
}
export function checkBusinessCase(context: BusinessContext, run: any, trace: any[], session: any): Record<string, boolean> {
  const { id, before, expectedTool, expectedArgs } = context;
  const calls = run.actual_tool_calls ?? [];
  const args = businessArguments(calls[0]);
  const terminal = id === 'NG04';
  const contract = terminal
    ? args?.outcome === 'conversation_complete' && typeof args?.summary === 'string' && args.summary.trim().length > 0 && Object.keys(args).every(k => ['outcome', 'summary'].includes(k))
    : isDeepStrictEqual(args, expectedArgs);
  const checks: Record<string, boolean> = {
    tool_contract: expectedTool ? calls.length === 1 && calls[0].function.name === expectedTool && contract : calls.length === 0,
    backend_execution: expectedTool ? trace.length === 1 && trace[0].tool === expectedTool && trace[0].ok === true : trace.length === 0,
    verification_preserved: session?.verified === true && session?.check?.eligible === true,
    closure_policy: terminal ? !!session?.finalizedAt && session?.finalOutcome === 'failed_negotiation' : !session?.finalizedAt,
  };
  if (id === 'LS01') checks.exact_saved_search = isDeepStrictEqual(trace[0]?.search_arguments, expectedArgs);
  if (id === 'PI02') checks.interest_saved = session?.loadInterest?.status === 'recorded' && session.loadInterest.load_id === context.loadId && session.loadInterest.callback_number === context.callback && session.loadInterest.notification_sent === false && session.loadInterest.callback_guaranteed === false;
  else checks.no_extra_interest = isDeepStrictEqual(session?.loadInterest, before?.loadInterest);
  if (id === 'NG01') checks.agreement_saved = session?.negotiation?.status === 'agreed' && session.negotiation.load_id === context.loadId && session.negotiation.offer_id === context.offerId && session.negotiation.agreed_rate === before.negotiation.offered_rate;
  else if (id === 'NG02') checks.counter_saved = trace[0]?.negotiation_arguments?.amount === context.amount && trace[0]?.negotiation_arguments?.offer_id === context.offerId && session?.negotiation?.counter_rounds === before.negotiation.counter_rounds + 1 && ['offered', 'agreed'].includes(session?.negotiation?.status);
  else if (id === 'NG03') checks.rejection_saved = session?.negotiation?.status === 'rejected' && session.negotiation.offer_id === context.offerId && session.negotiation.counter_rounds === before.negotiation.counter_rounds;
  else checks.negotiation_preserved = isDeepStrictEqual(session?.negotiation, before?.negotiation);
  if (id === 'BK01') checks.booking_saved = session?.booking?.status === 'confirmed' && !!session.booking.reference && session.booking.simulated === true && session.booking.load_id === context.loadId && isDeepStrictEqual(trace[0]?.booking_arguments, expectedArgs);
  else checks.no_new_booking = isDeepStrictEqual(session?.booking, before?.booking);
  if (id === 'BK02') checks.saved_request = session?.booking?.status === 'confirmed' && session.booking.simulated === true;
  if (id === 'BK03') checks.uncertain_attempt_preserved = session?.booking?.status === 'uncertain' && session.booking.attempt_id === before.booking.attempt_id;
  if (id === 'NG04') checks.round_limit_preserved = session?.negotiation?.status === 'failed' && session.negotiation.counter_rounds === 3;
  return checks;
}
