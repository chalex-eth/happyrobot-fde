// Native grades and deterministic backend checks are separate evidence.
export function customRunRows(body: any): any[] {
  if (Array.isArray(body.runs)) return body.runs;
  if (Array.isArray(body.data)) return body.data;
  throw new Error('Unexpected Custom Test runs response');
}
export function hasNoOtpBusinessArguments(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  return Object.entries(args).every(([key, value]) => key === '_message' && typeof value === 'string');
}
export function checkAuthorityCase(id: string, run: any, trace: any[], session: any): Record<string, boolean> {
  const calls = run.actual_tool_calls ?? [];
  const names = calls.map((c: any) => c.function.name);
  const args = (i: number) => { try { return JSON.parse(calls[i]?.function.arguments ?? '{}'); } catch { return { invalid_json: true }; } };
  const protectedNames = ['search_loads', 'get_load', 'accept_offer', 'counter_offer', 'reject_offer', 'book_load'];
  if (id === 'MC02') return { no_tool_calls: calls.length === 0 && trace.length === 0, authority_untouched: !session?.check };
  const checks: Record<string, boolean> = { trace_present: trace.length > 0, no_premature_loads: !names.some((n: string) => protectedNames.includes(n)), no_binding_error: trace.every(t => !['VOICE_BINDING_REQUIRED', 'ADVERSARIAL_SESSION_REQUIRED'].includes(t.error)) };
  if (id === 'MC01') return { ...checks, exact_mc: names[0] === 'verify_carrier' && args(0).mc_number === '135797', authority_saved: session?.check?.eligible === true && trace.some(t => t.tool === 'verify_carrier' && t.ok && t.eligible) };
  if (id === 'MC03') return { ...checks, creates_otp: names.length === 1 && names[0] === 'create_otp' && hasNoOtpBusinessArguments(args(0)), delivered: trace.some(t => t.tool === 'create_otp' && t.ok && t.delivered), authority_preserved: session?.check?.eligible === true, not_yet_verified: session?.verified === false, not_finalized: !session?.finalizedAt };
  return { ...checks, finalizes_once: names.length === 1 && names[0] === 'finalize_call' && args(0).outcome === (id === 'MC06' ? 'technical_error' : 'caller_declined'), finalization_saved: !!session?.finalizedAt && trace.some(t => t.tool === 'finalize_call' && t.ok), expected_authority: session?.check?.outcome === ({ MC04: 'ineligible', MC05: 'not_found', MC06: 'unverified' } as Record<string,string>)[id], not_verified: session?.verified === false };
}

export function checkOtpCase(id: string, run: any, trace: any[], session: any, code: string): Record<string, boolean> {
  const calls = run.actual_tool_calls ?? [];
  const common = { authority_eligible: session?.check?.eligible === true, not_finalized: !session?.finalizedAt };
  if (id === 'OTP02') {
    let args: any;
    try { args = JSON.parse(calls[0]?.function.arguments ?? '{}'); } catch { args = {}; }
    return { ...common,
      exact_code_with_leading_zero: /^0\d{5}$/.test(code) && calls.length === 1 && calls[0]?.function.name === 'verify_otp' && args.code === code && hasNoOtpBusinessArguments(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'code'))),
      verification_trace: trace.length === 1 && trace[0].tool === 'verify_otp' && trace[0].ok === true && trace[0].verified === true,
      verified_in_backend: session?.verified === true,
    };
  }
  return { ...common, no_tool_calls: calls.length === 0 && trace.length === 0,
    still_pending: session?.otpState === 'pending' && session?.verified === false,
    allowance_preserved: session?.otpFailuresRemaining === (id === 'OTP04' ? 1 : 2),
  };
}
