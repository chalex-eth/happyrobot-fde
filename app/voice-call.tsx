'use client';

import { useEffect, useRef, useState } from 'react';
import type { VoiceConnection } from '@happyrobot-ai/sdk/voice';
import type { CallSession } from '../src/call-session';

type Phase = 'idle' | 'permission' | 'starting' | 'connecting' | 'connected' | 'reconnecting' | 'ending' | 'ended' | 'error';
const labels: Record<Phase, string> = {
  idle: 'Ready to call', permission: 'Waiting for microphone permission…', starting: 'Starting your call…',
  connecting: 'Connecting audio…', connected: 'Connected', reconnecting: 'Reconnecting…',
  ending: 'Ending call…', ended: 'Call ended', error: 'Call could not continue',
};
const errors: Record<string, string> = {
  HAPPYROBOT_NOT_CONFIGURED: 'Voice access is not configured on the server.',
  HAPPYROBOT_WORKFLOW_NOT_LIVE: 'The selected workflow has no published development version.',
  HAPPYROBOT_AUTH_REJECTED: 'HappyRobot rejected the server credentials.',
  HAPPYROBOT_VOICE_UNAVAILABLE: 'HappyRobot could not start the call. Start a new call before trying again.',
  VOICE_ALREADY_STARTED: 'This call already has a voice session. Start a new call to speak again.',
  SESSION_REQUIRED: 'This call expired. Start a new call.',
  TWIN_UNAVAILABLE: 'The call could not be saved. Start a new call before trying again.',
};

export function VoiceCall({ session, disabled, ensureCall, onSession, onActive }: {
  session: CallSession | null; disabled: boolean;
  ensureCall: () => Promise<CallSession>; onSession: (session: CallSession) => void;
  onActive: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState('');
  const [muted, setMuted] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [needsPlayback, setNeedsPlayback] = useState(false);
  const [agentJoined, setAgentJoined] = useState(false);
  const connection = useRef<VoiceConnection | null>(null);
  const mounted = useRef(true);
  const starting = useRef(false);
  const boundCall = useRef<string | null>(null);

  async function stopRun(callId: string) {
    const response = await fetch('/api/local/voice/end', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId }), signal: AbortSignal.timeout(15000), cache: 'no-store', keepalive: true });
    if (!response.ok) throw new Error('END_FAILED');
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void connection.current?.disconnect().catch(() => {}); };
  }, []);
  useEffect(() => {
    if (boundCall.current && session?.callId !== boundCall.current) {
      void connection.current?.disconnect().catch(() => {}); connection.current = null;
      onActive(false);
      boundCall.current = null; setPhase('idle'); setNotice(''); setAgentJoined(false); setMuted(false);
    }
  }, [session?.callId, onActive]);

  async function start() {
    if (starting.current || connection.current) return;
    starting.current = true; onActive(true); setPhase('permission'); setNotice(''); setMuted(false); setAgentJoined(false);
    let callId: string | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('MIC_UNAVAILABLE');
      // Ask before creating a paid remote run. Release this permission-check
      // stream immediately; the voice SDK owns the actual call microphone.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      if (!mounted.current) return;
      setPhase('starting');
      const call = await ensureCall(); callId = call.callId; boundCall.current = callId;
      const response = await fetch('/api/local/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId }), signal: AbortSignal.timeout(30000), cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(errors[result.error] ?? 'Voice startup failed. Start a new call before retrying.');
      if (!mounted.current || boundCall.current !== callId || result.session.callId !== callId) { await stopRun(callId); return; }
      onSession(result.session); setPhase('connecting');
      const { HappyRobotVoiceClient } = await import('@happyrobot-ai/sdk/voice');
      const voice = new HappyRobotVoiceClient(result.voice);
      const connected = await voice.connect({
        onAgentConnected: () => { if (mounted.current) setAgentJoined(true); },
        onDisconnected: () => {
          connection.current = null;
          if (mounted.current) { setPhase('ended'); if (!starting.current) onActive(false); setNeedsPlayback(false); }
        },
        onReconnecting: () => { if (mounted.current) setPhase('reconnecting'); },
        onReconnected: () => { if (mounted.current) setPhase('connected'); },
      });
      if (!mounted.current || boundCall.current !== callId) { await connected.disconnect(); await stopRun(callId); return; }
      if (connected.room.state === 'disconnected') { setPhase('ended'); return; }
      connection.current = connected;
      setAgentJoined(connected.room.remoteParticipants.size > 0); setPhase('connected');
      try { await connected.room.startAudio(); } catch { /* User can explicitly enable playback below. */ }
      setNeedsPlayback(!connected.room.canPlaybackAudio);
    } catch (error) {
      if (callId) { try { await stopRun(callId); } catch { /* Audio is stopped locally; never retry startup automatically. */ } }
      if (!mounted.current) return;
      setPhase('error');
      const name = error instanceof Error ? error.name : '';
      setNotice(name === 'NotAllowedError' ? 'Microphone access was blocked. Allow microphone access for this page, then try again.'
        : name === 'NotFoundError' ? 'No microphone was found. Connect a microphone and try again.'
        : name === 'NotReadableError' ? 'The microphone is busy or unavailable. Check your audio settings and try again.'
        : error instanceof Error && errorsHasMessage(error.message) ? error.message
        : 'Audio could not connect. Check microphone access and your connection, then start a new call.');
    } finally {
      starting.current = false;
      if (mounted.current && !connection.current) onActive(false);
    }
  }
  async function end() {
    setPhase('ending');
    const current = connection.current; connection.current = null;
    try { await current?.disconnect(); }
    catch { setNotice('The audio connection could not close cleanly. Close this page if audio continues.'); }
    finally {
      try { if (boundCall.current) await stopRun(boundCall.current); }
      catch { setNotice('Audio stopped. HappyRobot could not confirm the run ended.'); }
      if (mounted.current) { setPhase('ended'); onActive(false); setNeedsPlayback(false); }
    }
  }
  const live = phase === 'connected' || phase === 'reconnecting';
  const working = ['permission','starting','connecting','ending'].includes(phase);
  const alreadyUsed = !!session && session.voiceState !== 'idle';
  return <section className="panel" aria-labelledby="voice-title">
    <h2 id="voice-title">Speak with the agent</h2>
    <p>Start a voice call and keep this page open. Your verification code and call progress will appear here.</p>
    <div className="connection">
      <button onClick={() => void start()} disabled={disabled || working || live || alreadyUsed}>Start voice call</button>
      {live && <button className="secondary" disabled={muteBusy} aria-pressed={muted} onClick={async () => {
        const current = connection.current; if (!current) return;
        setMuteBusy(true);
        try { if (muted) await current.unmute(); else await current.mute(); setMuted(current.isMuted()); }
        catch { setNotice('The microphone could not be changed. Try again.'); }
        finally { setMuteBusy(false); }
      }}>{muted ? 'Unmute microphone' : 'Mute microphone'}</button>}
      {live && <button className="secondary" onClick={() => void end()}>End call</button>}
      {needsPlayback && live && <button className="secondary" onClick={async () => {
        try { await connection.current?.room.startAudio(); setNeedsPlayback(!connection.current?.room.canPlaybackAudio); }
        catch { setNotice('Allow audio playback in your browser and try again.'); }
      }}>Enable audio</button>}
    </div>
    <p role="status" aria-live="polite">{labels[phase]}{phase === 'connected' ? agentJoined ? ' · Agent joined' : ' · Waiting for agent' : ''}{live && muted ? ' · Microphone muted' : ''}</p>
    {notice && <p role="alert" className="notice error">{notice}</p>}
    {alreadyUsed && !live && !working && <p>Use <strong>Start new call</strong> below for another conversation. Reloading ends browser audio; a previous voice session cannot be resumed here.</p>}
    <p className="hint">The agent handles carrier checks, sends your code and searches for loads. You only need to speak.</p>
  </section>;
}

function errorsHasMessage(message: string) {
  return Object.values(errors).includes(message) || message === 'Voice startup failed. Start a new call before retrying.';
}
