-- M3.1 additive upgrade. Apply after twin-m3.sql, once.
BEGIN;
ALTER TABLE public.poc_calls ALTER COLUMN authority_check DROP NOT NULL;
ALTER TABLE public.poc_calls ADD COLUMN authority_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN available_load_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN selected_load_id text,
  ADD COLUMN voice_run_id text UNIQUE,
  ADD COLUMN voice_state text NOT NULL DEFAULT 'idle' CHECK (voice_state IN ('idle','creating','ready','failed'));

CREATE OR REPLACE FUNCTION public.poc_call_action(
  p_session_hash text, p_action text, p_challenge uuid DEFAULT NULL,
  p_digest text DEFAULT NULL, p_recipient text DEFAULT NULL, p_metadata jsonb DEFAULT '{}'::jsonb,
  p_matches boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  c public.poc_calls%ROWTYPE;
  last_send timestamptz;
  sends integer;
  failure text;
  retry_seconds integer;
BEGIN
  -- Serialize sends for the same demo inbox across sessions/MC numbers.
  IF p_action = 'issue' THEN
    IF p_recipient IS NULL OR length(p_recipient) > 254 THEN RAISE EXCEPTION 'Invalid recipient'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_recipient, 0));
  END IF;
  SELECT * INTO c FROM public.poc_calls WHERE session_hash = p_session_hash FOR UPDATE;
  IF NOT FOUND OR c.session_expires_at <= now() THEN
    RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED');
  END IF;

  IF c.otp_state IN ('pending','dispatching') AND c.otp_expires_at <= now() THEN
    UPDATE public.poc_calls SET otp_state='expired', otp_digest=NULL WHERE id=c.id;
    c.otp_state := 'expired';
    INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'otp_expired');
  END IF;
  IF c.otp_state = 'verified' AND c.otp_verified_at + interval '5 minutes' <= now() THEN
    UPDATE public.poc_calls SET otp_state='expired' WHERE id=c.id;
    c.otp_state := 'expired';
    INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'verification_expired');
  END IF;

  IF p_action NOT IN ('status','event','authority_begin','authority_complete','voice_reserve','voice_bind','voice_failed') AND NOT c.authority_passed THEN
    failure := 'AUTHORITY_REQUIRED';
  ELSIF p_action = 'voice_reserve' THEN
    IF c.voice_state <> 'idle' THEN failure := 'VOICE_ALREADY_STARTED';
    ELSE
      UPDATE public.poc_calls SET voice_state='creating' WHERE id=c.id;
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'voice_requested');
    END IF;
  ELSIF p_action = 'voice_bind' THEN
    IF c.voice_state <> 'creating' THEN failure := 'VOICE_ALREADY_STARTED';
    ELSIF coalesce(p_metadata->>'runId','') !~ '^[0-9a-f]{8}-[0-9a-f-]{27}$' THEN RAISE EXCEPTION 'Invalid run';
    ELSE
      UPDATE public.poc_calls SET voice_state='ready',voice_run_id=p_metadata->>'runId' WHERE id=c.id;
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'voice_bound');
    END IF;
  ELSIF p_action = 'voice_failed' THEN
    UPDATE public.poc_calls SET voice_state='failed' WHERE id=c.id AND voice_state='creating';
    INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'voice_start_failed');
  ELSIF p_action = 'authority_begin' THEN
    IF coalesce(p_metadata->>'mcNumber','') !~ '^[0-9]{1,10}$' THEN RAISE EXCEPTION 'Invalid MC'; END IF;
    -- Rechecks deliberately require fresh OTP, even for the same MC. Preserve
    -- call identity while invalidating all capabilities based on old evidence.
    UPDATE public.poc_calls SET authority_revision=authority_revision+1,
      authority_check=jsonb_build_object('mcNumber',p_metadata->>'mcNumber',
        'eligible',false,'outcome','unverified','reason','AUTHORITY_CHECKING','checkedAt',now()),
      authority_passed=false, otp_state='not_sent', challenge_id=NULL,
      otp_digest=NULL, otp_expires_at=NULL, otp_attempts=0, otp_verified_at=NULL,
      available_load_ids='[]'::jsonb, selected_load_id=NULL WHERE id=c.id;
    INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'authority_check_started');
  ELSIF p_action = 'authority_complete' THEN
    IF (p_metadata->>'revision')::integer IS DISTINCT FROM c.authority_revision
       OR p_metadata->'check'->>'mcNumber' IS DISTINCT FROM c.authority_check->>'mcNumber' THEN
      failure := 'CALL_CHANGED';
    ELSE
      UPDATE public.poc_calls SET authority_check=p_metadata->'check',
        authority_passed=coalesce(p_metadata->'check'->>'eligible'='true'
          AND p_metadata->'check'->>'outcome'='eligible',false) WHERE id=c.id;
      INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'authority_checked',
        jsonb_build_object('outcome',p_metadata->'check'->>'outcome','reason',p_metadata->'check'->>'reason'));
    END IF;
  ELSIF p_action = 'issue' THEN
    IF c.otp_state = 'verified' THEN
      failure := 'ALREADY_VERIFIED';
    ELSE
      SELECT max(e.created_at), count(*) INTO last_send, sends
      FROM public.poc_call_events e JOIN public.poc_calls pc ON pc.id=e.call_id
      WHERE e.event='otp_requested' AND pc.demo_recipient=p_recipient
        AND e.created_at > now()-interval '15 minutes';
      IF last_send > now()-interval '60 seconds' OR sends >= 3 THEN
        failure := 'OTP_RATE_LIMITED';
        retry_seconds := CASE WHEN sends >= 3 THEN 900 ELSE greatest(1,ceil(extract(epoch FROM last_send+interval '60 seconds'-now()))::integer) END;
      ELSE
        IF p_challenge IS NULL OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid challenge'; END IF;
        UPDATE public.poc_calls SET challenge_id=p_challenge, otp_digest=p_digest,
          otp_state='dispatching', otp_expires_at=now()+interval '10 minutes', otp_attempts=0,
          demo_recipient=p_recipient WHERE id=c.id;
        INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'otp_requested');
      END IF;
    END IF;
  ELSIF p_action IN ('sent','failed') THEN
    IF c.challenge_id IS DISTINCT FROM p_challenge OR c.otp_state <> 'dispatching' THEN
      failure := 'OTP_CHALLENGE_CHANGED';
    ELSE
      UPDATE public.poc_calls SET otp_state=CASE WHEN p_action='sent' THEN 'pending' ELSE 'failed' END,
        otp_digest=CASE WHEN p_action='sent' THEN otp_digest ELSE NULL END WHERE id=c.id;
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id, CASE WHEN p_action='sent' THEN 'otp_dispatch_accepted' ELSE 'otp_dispatch_failed' END);
    END IF;
  ELSIF p_action IN ('prepare_verify','verify') THEN
    IF c.otp_state = 'verified' THEN
      failure := 'OTP_ALREADY_USED';
    ELSIF c.challenge_id IS DISTINCT FROM p_challenge THEN
      failure := 'OTP_CHALLENGE_CHANGED';
    ELSIF c.otp_state <> 'pending' THEN
      failure := CASE c.otp_state WHEN 'expired' THEN 'OTP_EXPIRED' WHEN 'locked' THEN 'OTP_LOCKED' ELSE 'OTP_NOT_READY' END;
    ELSIF p_action = 'prepare_verify' THEN
      -- Internal backend response only. Next.js compares fixed-size HMACs with
      -- timingSafeEqual, then commits the result against this immutable challenge.
      RETURN jsonb_build_object('ok',true,'verifier',c.otp_digest);
    ELSIF p_matches THEN
      UPDATE public.poc_calls SET otp_state='verified',otp_verified_at=now(),otp_digest=NULL WHERE id=c.id;
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'otp_verified');
    ELSE
      UPDATE public.poc_calls SET otp_attempts=otp_attempts+1,
        otp_state=CASE WHEN otp_attempts+1>=5 THEN 'locked' ELSE 'pending' END,
        otp_digest=CASE WHEN otp_attempts+1>=5 THEN NULL ELSE otp_digest END WHERE id=c.id;
      failure := CASE WHEN c.otp_attempts+1>=5 THEN 'OTP_LOCKED' ELSE 'OTP_INVALID' END;
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'otp_rejected');
    END IF;
  ELSIF p_action IN ('authorize_load','save_loads') THEN
    IF c.otp_state <> 'verified' THEN
      failure := 'OTP_REQUIRED';
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'load_access_denied');
    ELSIF p_action='save_loads' AND (p_metadata->>'revision')::integer IS DISTINCT FROM c.authority_revision THEN
      failure := 'CALL_CHANGED';
    ELSIF p_metadata->>'command'='LOAD_GET' AND NOT (c.available_load_ids ? (p_metadata->>'loadId')) THEN
      failure := 'LOAD_NOT_IN_CALL';
    ELSIF p_action='save_loads' THEN
      IF p_metadata->>'ok'='true' AND p_metadata->>'command'='LOAD_QUERY' THEN
        UPDATE public.poc_calls SET available_load_ids=p_metadata->'loadIds',selected_load_id=NULL WHERE id=c.id;
      ELSIF p_metadata->>'ok'='true' AND p_metadata->>'command'='LOAD_GET' THEN
        UPDATE public.poc_calls SET selected_load_id=p_metadata->>'loadId' WHERE id=c.id;
      END IF;
      INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'load_result',p_metadata);
    ELSE
      INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'load_requested',p_metadata);
    END IF;
  ELSIF p_action = 'event' THEN
    INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'load_result',p_metadata);
  ELSIF p_action <> 'status' THEN
    RAISE EXCEPTION 'Unknown action';
  END IF;

  SELECT * INTO c FROM public.poc_calls WHERE id=c.id;
  RETURN jsonb_build_object('ok',failure IS NULL,'error',failure,'retryAfterSeconds',retry_seconds,
    'session',jsonb_build_object('callId',c.id,'check',c.authority_check,
      'voiceState',c.voice_state,'voiceRunId',c.voice_run_id,
      'authorityRevision',c.authority_revision,'availableLoadIds',c.available_load_ids,'selectedLoadId',c.selected_load_id,
      'expiresAt',c.session_expires_at,'otpState',c.otp_state,'challengeId',c.challenge_id,
      'otpExpiresAt',c.otp_expires_at,'attemptsRemaining',greatest(0,5-c.otp_attempts),
      'verifiedUntil',CASE WHEN c.otp_state='verified' THEN c.otp_verified_at+interval '5 minutes' ELSE NULL END,
      'verified',c.authority_passed AND c.otp_state='verified','demo',true));
END;
$$;


-- A pending call exists before any authority lookup or future voice startup.
CREATE FUNCTION public.poc_start_call(p_id uuid,p_session_hash text,p_previous_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE public.poc_calls SET session_expires_at=now(),otp_digest=NULL
    WHERE session_hash=p_previous_hash;
  INSERT INTO public.poc_calls(id,session_hash,authority_check,authority_passed)
    VALUES(p_id,p_session_hash,NULL,false);
  INSERT INTO public.poc_call_events(call_id,event) VALUES(p_id,'call_started');
  RETURN public.poc_call_action(p_session_hash,'status');
END;
$$;
-- Internal backend resolver. A run ID alone is not authentication: the agent
-- adapter must validate its bearer secret before calling this RPC.
CREATE FUNCTION public.poc_resolve_voice(p_run_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h text;
BEGIN
  SELECT session_hash INTO h FROM public.poc_calls WHERE voice_run_id=p_run_id
    AND voice_state='ready' AND session_expires_at>now();
  IF h IS NULL THEN RETURN jsonb_build_object('ok',false,'error','VOICE_BINDING_REQUIRED'); END IF;
  RETURN jsonb_build_object('ok',true,'sessionHash',h);
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
