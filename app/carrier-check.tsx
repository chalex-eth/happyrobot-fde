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
  const session = view.session;
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
  const finalized = !!session?.finalizedAt;
  const code = voiceActive && !error && !finalized && !session?.verified && session?.otpState === 'pending'
    && view.demoOtp?.challengeId === session.challengeId ? view.demoOtp.code : null;
  useEffect(() => { window.dispatchEvent(new Event('carrier-call-updated')); }, [session?.callId, finalized, voiceActive]);
  return <div className="demo-banner">
    <div className="demo-intro"><h1>Talk freight. Find your next load.</h1>
      <p>Try a conversation with our carrier-sales agent.</p>
      <div className="demo-cues"><span>MC <strong>135797</strong></span><span>From <strong>Salt Lake City</strong></span><span>Try a counter of <strong>$2,700</strong></span></div>
    </div>
    <div className="demo-interaction">
      <VoiceCall session={session} disabled={busy || restoring}
        ensureCall={async () => session && session.voiceState==='idle' && !finalized && Date.parse(session.expiresAt)>Date.now() ? session : await newCall()}
        onSession={next => setView(previous => ({ session: next,
          demoOtp: previous.demoOtp?.challengeId === next.challengeId ? previous.demoOtp : null }))}
        onActive={setVoiceActive} />
      <div className={'demo-code'+(code?' ready':'')} aria-live="polite">
        {code ? <><span>Read this code to the agent</span><output aria-label="Your verification code">{code}</output><small>Demo code · displayed here instead of email/SMS</small></>
          : <><span>Verification code</span><p>Your code appears here during the call.</p><small>Keep this page open and speak naturally.</small></>}
      </div>
      {error && <p role="alert" className="notice error">{error}</p>}
    </div>
  </div>;
}
