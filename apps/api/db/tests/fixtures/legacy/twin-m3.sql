-- M3 only: run once in this workspace's Twin SQL console, then keep in Git.
-- Additive POC tables. Does not alter existing business tables or grant table access.
BEGIN;

CREATE TABLE public.poc_calls (
  id uuid PRIMARY KEY,
  session_hash text NOT NULL UNIQUE CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  authority_check jsonb NOT NULL,
  authority_passed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  session_expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  otp_state text NOT NULL DEFAULT 'not_sent' CHECK (otp_state IN ('not_sent','dispatching','pending','failed','expired','locked','verified')),
  challenge_id uuid,
  otp_digest text,
  otp_expires_at timestamptz,
  otp_attempts integer NOT NULL DEFAULT 0,
  otp_verified_at timestamptz,
  demo_recipient text
);

CREATE TABLE public.poc_call_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES public.poc_calls(id),
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX poc_events_call_time ON public.poc_call_events(call_id, created_at);
CREATE INDEX poc_events_send_time ON public.poc_call_events(created_at) WHERE event = 'otp_requested';

CREATE FUNCTION public.poc_create_call(p_id uuid, p_session_hash text, p_check jsonb, p_previous_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- A new lookup invalidates the preceding session, including its verified OTP.
  UPDATE public.poc_calls SET session_expires_at = now(), otp_digest = NULL
    WHERE session_hash = p_previous_hash;
  INSERT INTO public.poc_calls(id, session_hash, authority_check, authority_passed)
    VALUES (p_id, p_session_hash, p_check,
      coalesce(p_check->>'outcome' = 'eligible' AND p_check->>'eligible' = 'true', false));
  INSERT INTO public.poc_call_events(call_id, event, metadata)
    VALUES(p_id, 'authority_checked', jsonb_build_object('outcome',p_check->>'outcome','reason',p_check->>'reason'));
  RETURN jsonb_build_object('ok',true,'callId',p_id);
END;
$$;

-- Each transition runs in one transaction with a call row lock. The browser
-- never calls this function directly; org credentials stay in Next.js routes.
CREATE FUNCTION public.poc_call_action(
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

  IF p_action NOT IN ('status','event') AND NOT c.authority_passed THEN
    failure := 'AUTHORITY_REQUIRED';
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
  ELSIF p_action = 'authorize_load' THEN
    IF c.otp_state <> 'verified' THEN
      failure := 'OTP_REQUIRED';
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'load_access_denied');
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
      'expiresAt',c.session_expires_at,'otpState',c.otp_state,'challengeId',c.challenge_id,
      'otpExpiresAt',c.otp_expires_at,'attemptsRemaining',greatest(0,5-c.otp_attempts),
      'verifiedUntil',CASE WHEN c.otp_state='verified' THEN c.otp_verified_at+interval '5 minutes' ELSE NULL END,
      'verified',c.authority_passed AND c.otp_state='verified','demo',true));
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
