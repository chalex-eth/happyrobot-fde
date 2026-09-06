'use client';

import { useEffect, useState } from 'react';
import type { CallSession } from '../src/call-session';
import { VoiceCall } from './voice-call';

type View = { session: CallSession | null; demoOtp: { code: string; challengeId: string; failuresRemaining: number } | null };
const empty: View = { session: null, demoOtp: null };

export function CarrierVerification() {
  const [view, setView] = useState<View>(empty);
  const [voiceActive, setVoiceActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const session = view.session;
  useEffect(() => {
    const tick = () => setNow(Date.now()); tick();
    const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let keepPolling = true;
      try {
        const response = await fetch('/api/local/calls', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status' }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), cache: 'no-store' });
        const result = await response.json();
        if (controller.signal.aborted) return;
        if (response.ok && result.ok) {
          setView({ session: result.session, demoOtp: result.demoOtp ?? null }); setError('');
        } else if (result.error === 'SESSION_REQUIRED') { setView(empty); keepPolling = false; }
        else throw new Error('Status unavailable');
      } catch {
        if (!controller.signal.aborted) {
          setView(previous => ({ ...previous, demoOtp: null }));
          setError('Call updates are temporarily unavailable. Reconnecting…');
        }
      } finally { if (!controller.signal.aborted) setRestoring(false); }
      if (keepPolling && !controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [session?.callId, busy]);

  async function newCall() {
    setBusy(true); setError(''); setView(previous => ({ ...previous, demoOtp: null }));
    try {
      const response = await fetch('/api/local/calls', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }), signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error('Could not start a call. Please try again.');
      setView({ session: result.session, demoOtp: null }); return result.session as CallSession;
    } finally { setBusy(false); }
  }
  const negotiation = session?.negotiation;
  const booking = session?.booking;
  const finalized = !!session?.finalizedAt;
  const verified = !!session?.verified;
  const code = !error && !finalized && !verified && session?.otpState === 'pending'
    && view.demoOtp?.challengeId === session.challengeId ? view.demoOtp.code : null;
  const authority = session?.check?.eligible ? 'Carrier approved'
    : !session?.check ? 'Waiting for your MC number'
    : session.check.reason === 'AUTHORITY_CHECKING' ? 'Checking carrier authority…'
    : session.check.outcome === 'unverified' ? 'Authority could not be confirmed' : 'Carrier not approved';
  const otpFailed = session?.otpFailuresRemaining === 0 && !verified;
  const otpStatus = otpFailed ? 'Verification failed' : verified ? 'Code verified' : code ? session?.otpFailuresRemaining === 1 ? 'One retry available · read your code again' : 'Read your code to the agent'
    : session?.otpFailuresRemaining === 1 ? 'One retry available'
    : session?.check?.eligible ? 'The agent will send your code' : 'Waiting for carrier approval';

  return <>
    <VoiceCall session={session} disabled={busy || restoring || finalized}
      ensureCall={async () => session ?? await newCall()}
      onSession={next => setView(previous => ({ session: next,
        demoOtp: previous.demoOtp?.challengeId === next.challengeId ? previous.demoOtp : null }))}
      onActive={setVoiceActive} />
    {error && <p role="alert" className="notice error">{error}</p>}
    <section className="panel" aria-labelledby="progress-title">
      <h2 id="progress-title">Your call</h2>
      {session?.check?.carrier && <p><strong>{session.check.carrier.legalName}</strong> · MC {session.check.mcNumber}</p>}
      <ol className="call-progress" aria-label="Call progress">
        <li><span>Carrier</span><strong>{authority}</strong></li>
        <li><span>Verification</span><strong>{otpFailed ? 'Verification failed' : finalized ? 'Conversation ended' : otpStatus}</strong></li>
        <li><span>Loads</span><strong>{session?.selectedLoadId ? `Selected ${session.selectedLoadId}`
          : session?.availableLoadIds.length ? `${session.availableLoadIds.length} loads found`
          : verified ? 'Tell the agent your route' : 'Available after verification'}</strong></li>
      </ol>
      {!error && (verified || finalized) && negotiation && negotiation.status !== 'idle' && <div className="notice" role="status" aria-label="Negotiation status">
        <p><strong>{negotiation.status === 'agreed' ? 'Rate agreed' : negotiation.status === 'failed' ? 'Negotiation ended without agreement'
          : negotiation.status === 'rejected' ? 'Offer declined' : 'Current offer'} · {negotiation.load_id}</strong></p>
        {negotiation.status === 'agreed' && <p>${negotiation.agreed_rate?.toFixed(2)} agreed. {!booking && 'No load booked or reserved.'}</p>}
        {negotiation.status === 'offered' && <p>${negotiation.offered_rate?.toFixed(2)} · {Date.parse(negotiation.expires_at ?? '') <= now ? 'Offer expired; ask the agent to refresh it.' : 'Tell the agent whether you accept or want to counter.'}</p>}
        <small>{negotiation.counter_rounds} of 3 counter rounds used in this call.</small>
      </div>}
      {session?.loadInterest && <div className="notice" role="status" aria-label="Load interest">
        <p><strong>Interest recorded for manager review</strong> · {session.loadInterest.load_id}</p>
        <p>Callback number: {session.loadInterest.callback_number}</p>
        <p>Reference: {session.loadInterest.reference}</p>
        <p>This request does not book or reserve the load. No manager notification has been sent and a callback is not guaranteed.</p>
      </div>}
      {booking && <div className="notice" role="status" aria-label="Booking status">
        <p><strong>{booking.status === 'confirmed' ? (booking.simulated ? 'Simulated booking saved' : 'Booking confirmed') : booking.status === 'rejected' ? 'Booking failed'
          : booking.status === 'pending' ? 'Booking in progress' : 'Booking outcome unknown — review required'}</strong> · {booking.load_id}</p>
        {booking.status === 'confirmed' && <><p>Reference: {booking.reference}</p><p>Senior-representative handoff recorded as a simulation. No live transfer occurred.</p></>}
        {booking.simulated && <p>Test booking only. No booking request was sent to the TMS and no load was reserved.</p>}
        {booking.status === 'uncertain' && <p>Confirmation is unavailable. Do not submit another booking for this load until it has been reviewed.</p>}
        {booking.status === 'rejected' && <p>This attempt did not confirm a booking. The agreed rate remains recorded.</p>}
      </div>}
      {otpFailed && <p role="status" className="notice error">Verification could not be completed after two failures. Please start a new call.</p>}
      {code && <div className="otp-display">
        <p>Your verification code</p>
        <output aria-label="Your verification code">{code}</output>
        <p>Read these six digits aloud to the agent.</p>
        <small>Valid for this call.</small>
      </div>}
      {finalized && <p role="status" className="notice">Conversation saved. {!booking && 'No load has been booked.'}</p>}
      <p className="hint">Demo verification · The code appears here instead of being sent by email or SMS.</p>
      {session && <div className="call-actions">
        <button className="secondary" disabled={busy || voiceActive} onClick={() => void newCall().catch(() => setError('Could not start a new call. Please try again.'))}>Start new call</button>
        <details><summary>Call details</summary><p className="hint">{session.callId}</p></details>
      </div>}
    </section>
  </>;
}
