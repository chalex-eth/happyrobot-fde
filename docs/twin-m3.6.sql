-- M3.6: apply once after m3.5. One shared retry, no independent OTP timers.
-- Existing event history and legacy columns remain for historical evidence.
BEGIN;
ALTER TABLE public.poc_calls ADD COLUMN otp_failures integer NOT NULL DEFAULT 0 CHECK (otp_failures BETWEEN 0 AND 2);
CREATE TABLE poc_private.otp_receipts (
  call_id uuid NOT NULL REFERENCES public.poc_calls(id),
  operation_id text NOT NULL,
  authority_revision integer NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(call_id,operation_id)
);
-- Preserve spent failures on active legacy calls; never revive a consumed code.
UPDATE public.poc_calls c SET otp_failures=least(2,greatest(c.otp_attempts,
  (SELECT count(*)::int FROM public.poc_call_events e WHERE e.call_id=c.id
    AND e.event IN ('otp_rejected','otp_dispatch_failed')))),
  otp_expires_at=NULL WHERE finalized_at IS NULL AND session_expires_at>now();
UPDATE public.poc_calls SET otp_state=CASE
    WHEN otp_failures>=2 AND otp_state<>'verified' THEN 'failed'
    WHEN otp_state IN ('expired','locked') THEN 'not_sent' ELSE otp_state END,
  otp_digest=CASE WHEN otp_failures>=2 OR otp_state IN ('expired','locked') THEN NULL ELSE otp_digest END
  WHERE finalized_at IS NULL AND session_expires_at>now();

CREATE OR REPLACE FUNCTION poc_private.poc_call_action(
  p_session_hash text, p_action text, p_challenge uuid DEFAULT NULL,
  p_digest text DEFAULT NULL, p_recipient text DEFAULT NULL, p_metadata jsonb DEFAULT '{}'::jsonb,
  p_matches boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  c public.poc_calls%ROWTYPE;
  failure text;
  operation text := p_metadata->>'operationId';
  receipt poc_private.otp_receipts%ROWTYPE;
  result jsonb;
  completed boolean := false;
BEGIN
  SELECT * INTO c FROM public.poc_calls WHERE session_hash = p_session_hash FOR UPDATE;
  IF NOT FOUND OR c.session_expires_at <= now() THEN
    RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED');
  END IF;

  -- Receipts reconcile a lost response without counting or executing it twice.
  IF operation IS NOT NULL AND p_action IN ('issue','sent','failed','otp_failure','prepare_verify','verify','otp_result') THEN
    IF operation !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'Invalid operation'; END IF;
    SELECT * INTO receipt FROM poc_private.otp_receipts WHERE call_id=c.id AND operation_id=operation;
    IF FOUND THEN
      IF receipt.authority_revision<>c.authority_revision THEN
        RETURN jsonb_build_object('ok',false,'error','CALL_CHANGED');
      END IF;
      IF receipt.fingerprint IS DISTINCT FROM coalesce(p_metadata->>'fingerprint','') THEN
        RETURN jsonb_build_object('ok',false,'error','OTP_OPERATION_CHANGED');
      END IF;
      -- Never return a stale retry budget after another operation completed.
      result:=receipt.result;
      result:=jsonb_set(result,'{session}',poc_private.poc_call_action(p_session_hash,'status')->'session');
      RETURN result || jsonb_build_object('replayed',true);
    END IF;
  END IF;

  IF p_action NOT IN ('status','event','otp_result','authority_begin','authority_complete','voice_reserve','voice_bind','voice_failed') AND NOT c.authority_passed THEN
    failure := 'AUTHORITY_REQUIRED';
  ELSIF p_action = 'otp_result' THEN
    failure := 'OTP_RESULT_UNCERTAIN';
  ELSIF p_action IN ('issue','sent','failed','otp_failure','prepare_verify','verify') AND c.otp_failures >= 2 THEN
    failure := 'OTP_FAILED';
  ELSIF p_action = 'otp_failure' AND c.otp_state='verified' THEN
    failure := 'ALREADY_VERIFIED';
  ELSIF p_action = 'otp_failure' THEN
    UPDATE public.poc_calls SET otp_failures=otp_failures+1,
      otp_state=CASE WHEN otp_failures+1>=2 THEN 'failed' ELSE otp_state END,
      otp_digest=CASE WHEN otp_failures+1>=2 THEN NULL ELSE otp_digest END WHERE id=c.id;
    failure:=CASE WHEN c.otp_failures+1>=2 THEN 'OTP_FAILED' ELSE 'OTP_SERVICE_FAILED' END;
    completed:=true;
    INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'otp_service_failed');
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
      authority_passed=false, otp_state=CASE WHEN otp_failures>=2 THEN 'failed' ELSE 'not_sent' END, challenge_id=NULL,
      otp_digest=NULL, otp_expires_at=NULL, otp_verified_at=NULL,
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
    ELSIF c.otp_state IN ('pending','dispatching') THEN
      -- Repeated and concurrent creation requests cannot replace a usable code.
      NULL;
    ELSE
      IF p_challenge IS NULL OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
        OR p_recipient IS NULL OR length(p_recipient)>254 THEN RAISE EXCEPTION 'Invalid challenge'; END IF;
      UPDATE public.poc_calls SET challenge_id=p_challenge, otp_digest=p_digest,
        otp_state='dispatching', otp_expires_at=NULL, demo_recipient=p_recipient WHERE id=c.id;
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'otp_requested');
    END IF;
  ELSIF p_action IN ('sent','failed') THEN
    IF c.challenge_id IS DISTINCT FROM p_challenge THEN
      failure := 'OTP_CHALLENGE_CHANGED';
    ELSIF c.otp_state='pending' AND p_action='sent' THEN
      NULL;
    ELSIF c.otp_state<>'dispatching' THEN
      failure := 'OTP_NOT_READY';
    ELSE
      UPDATE public.poc_calls SET otp_state=CASE WHEN p_action='sent' THEN 'pending' ELSE 'failed' END,
        otp_digest=CASE WHEN p_action='sent' THEN otp_digest ELSE NULL END,
        otp_failures=otp_failures+CASE WHEN p_action='failed' THEN 1 ELSE 0 END WHERE id=c.id;
      IF p_action='failed' THEN
        failure:=CASE WHEN c.otp_failures+1>=2 THEN 'OTP_FAILED' ELSE 'OTP_DELIVERY_FAILED' END;
      END IF;
      completed:=true;
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,CASE WHEN p_action='sent' THEN 'otp_dispatch_accepted' ELSE 'otp_dispatch_failed' END);
    END IF;
  ELSIF p_action IN ('prepare_verify','verify') THEN
    IF c.otp_state = 'verified' THEN
      failure := 'OTP_ALREADY_USED';
    ELSIF c.challenge_id IS DISTINCT FROM p_challenge THEN
      failure := 'OTP_CHALLENGE_CHANGED';
    ELSIF c.otp_state <> 'pending' THEN
      failure := 'OTP_NOT_READY';
    ELSIF p_action = 'prepare_verify' THEN
      -- Internal backend response only. Next.js compares fixed-size HMACs with
      -- timingSafeEqual, then commits the result against this immutable challenge.
      RETURN jsonb_build_object('ok',true,'verifier',c.otp_digest);
    ELSIF p_matches THEN
      completed:=true;
      UPDATE public.poc_calls SET otp_state='verified',otp_verified_at=now(),otp_digest=NULL WHERE id=c.id;
      INSERT INTO public.poc_call_events(call_id,event) VALUES(c.id,'otp_verified');
    ELSE
      completed:=true;
      UPDATE public.poc_calls SET otp_failures=otp_failures+1,
        otp_state=CASE WHEN otp_failures+1>=2 THEN 'failed' ELSE 'pending' END,
        otp_digest=CASE WHEN otp_failures+1>=2 THEN NULL ELSE otp_digest END WHERE id=c.id;
      failure := CASE WHEN c.otp_failures+1>=2 THEN 'OTP_FAILED' ELSE 'OTP_INVALID' END;
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
  result:=jsonb_build_object('ok',failure IS NULL,'error',failure,
    'session',jsonb_build_object('callId',c.id,'check',c.authority_check,
      'voiceState',c.voice_state,'voiceRunId',c.voice_run_id,
      'authorityRevision',c.authority_revision,'availableLoadIds',c.available_load_ids,'selectedLoadId',c.selected_load_id,
      'expiresAt',c.session_expires_at,'otpState',c.otp_state,'challengeId',c.challenge_id,
      'otpFailuresRemaining',greatest(0,2-c.otp_failures),
      'otpRetryAllowed',c.otp_failures<2 AND c.otp_state<>'verified',
      'verified',c.authority_passed AND c.otp_state='verified','demo',true));
  IF completed AND operation IS NOT NULL THEN
    INSERT INTO poc_private.otp_receipts(call_id,operation_id,authority_revision,fingerprint,result)
      VALUES(c.id,operation,c.authority_revision,coalesce(p_metadata->>'fingerprint',''),result);
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.poc_negotiate(
  p_session_hash text,p_action text,p_load_id text,p_revision integer DEFAULT NULL,
  p_listed_cents bigint DEFAULT NULL,p_max_cents bigint DEFAULT NULL,
  p_offer_id uuid DEFAULT NULL,p_amount_cents bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; n poc_private.negotiations%ROWTYPE;
  receipt poc_private.offer_receipts%ROWTYPE; fp jsonb; r jsonb; candidate bigint; changed boolean:=false;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('quote','accept','counter','reject')
    OR p_load_id IS NULL OR p_load_id !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RETURN jsonb_build_object('ok',false,'error','INVALID_OFFER');
  END IF;
  SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
  IF NOT FOUND OR c.session_expires_at<=now() THEN RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED'); END IF;
  IF c.finalized_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error','CALL_FINALIZED'); END IF;
  IF NOT c.authority_passed THEN RETURN jsonb_build_object('ok',false,'error','AUTHORITY_REQUIRED'); END IF;
  IF c.otp_state<>'verified' OR c.otp_verified_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','OTP_REQUIRED');
  END IF;
  IF c.selected_load_id IS DISTINCT FROM p_load_id OR NOT (c.available_load_ids ? p_load_id) THEN
    RETURN jsonb_build_object('ok',false,'error','LOAD_NOT_SELECTED');
  END IF;
  SELECT * INTO n FROM poc_private.negotiations WHERE call_id=c.id FOR UPDATE;
  IF p_action='quote' THEN
    IF p_revision IS DISTINCT FROM c.authority_revision THEN RETURN jsonb_build_object('ok',false,'error','CALL_CHANGED'); END IF;
    IF p_listed_cents IS NULL OR p_max_cents IS NULL OR p_listed_cents<=0
      OR p_max_cents<p_listed_cents OR p_max_cents>100000000 THEN
      RETURN jsonb_build_object('ok',false,'error','TMS_PRICING_UNAVAILABLE');
    END IF;
    IF n.status='failed' THEN RETURN jsonb_build_object('ok',false,'error','NEGOTIATION_FAILED'); END IF;
    IF n.status='agreed' AND (n.load_id IS DISTINCT FROM p_load_id OR n.listed_cents<>p_listed_cents OR n.max_cents<>p_max_cents) THEN
      RETURN jsonb_build_object('ok',false,'error','NEGOTIATION_COMPLETE');
    END IF;
    IF n.call_id IS NULL THEN
      changed:=true;
      INSERT INTO poc_private.negotiations(call_id,authority_revision,load_id,listed_cents,max_cents,offered_cents,expires_at)
        VALUES(c.id,c.authority_revision,p_load_id,p_listed_cents,p_max_cents,p_listed_cents,now()+interval '2 minutes');
    ELSIF n.authority_revision IS DISTINCT FROM c.authority_revision OR n.load_id IS DISTINCT FROM p_load_id
      OR n.status='idle' OR (n.status='offered' AND (n.expires_at<=now() OR n.listed_cents<>p_listed_cents OR n.max_cents<>p_max_cents)) THEN
      changed:=true;
      UPDATE poc_private.negotiations SET authority_revision=c.authority_revision,load_id=p_load_id,
        listed_cents=p_listed_cents,max_cents=p_max_cents,
        offered_cents=CASE WHEN n.load_id=p_load_id AND n.authority_revision=c.authority_revision
          AND n.listed_cents=p_listed_cents AND n.offered_cents<=p_max_cents THEN n.offered_cents ELSE p_listed_cents END,
        agreed_cents=NULL,status='offered',offer_id=gen_random_uuid(),expires_at=now()+interval '2 minutes' WHERE call_id=c.id;
    END IF;
    r:=jsonb_build_object('ok',true,'negotiation',poc_private.negotiation_view(c.id,c.authority_revision,p_load_id));
    IF changed THEN
      INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'load_offer',r->'negotiation');
    END IF;
    RETURN r;
  END IF;

  IF p_offer_id IS NULL OR (p_action='counter' AND (p_amount_cents IS NULL OR p_amount_cents<=0 OR p_amount_cents>100000000))
    OR (p_action<>'counter' AND p_amount_cents IS NOT NULL) THEN RETURN jsonb_build_object('ok',false,'error','INVALID_OFFER'); END IF;
  fp:=jsonb_build_object('load',p_load_id,'action',p_action,'amount',p_amount_cents,'revision',c.authority_revision);
  SELECT * INTO receipt FROM poc_private.offer_receipts WHERE call_id=c.id AND offer_id=p_offer_id;
  IF FOUND THEN
    IF receipt.fingerprint=fp THEN RETURN receipt.result; END IF;
    RETURN jsonb_build_object('ok',false,'error','OFFER_ALREADY_ANSWERED');
  END IF;
  IF n.call_id IS NULL OR n.offer_id IS DISTINCT FROM p_offer_id OR n.authority_revision IS DISTINCT FROM c.authority_revision
    OR n.load_id IS DISTINCT FROM p_load_id THEN RETURN jsonb_build_object('ok',false,'error','OFFER_CHANGED'); END IF;
  IF n.status<>'offered' THEN RETURN jsonb_build_object('ok',false,'error','NEGOTIATION_COMPLETE'); END IF;
  IF n.expires_at<=now() THEN RETURN jsonb_build_object('ok',false,'error','OFFER_EXPIRED'); END IF;
  IF p_action='accept' THEN
    n.status:='agreed';n.agreed_cents:=n.offered_cents;
  ELSIF p_action='reject' THEN
    n.status:='rejected';
  ELSE
    IF n.counter_rounds>=3 THEN RETURN jsonb_build_object('ok',false,'error','NEGOTIATION_FAILED'); END IF;
    n.counter_rounds:=n.counter_rounds+1;
    IF p_amount_cents<=n.max_cents THEN
      n.status:='agreed';n.agreed_cents:=p_amount_cents;n.offered_cents:=p_amount_cents;
    ELSIF n.counter_rounds=3 THEN
      n.status:='failed';
    ELSE
      -- Counteroffers depend on the public listed rate and call round, never
      -- interpolate towards or clip to the private ceiling. If unsafe, hold.
      candidate:=n.listed_cents + (n.listed_cents*2*n.counter_rounds)/100;
      IF candidate<=n.max_cents THEN n.offered_cents:=greatest(n.offered_cents,candidate); END IF;
    END IF;
  END IF;
  UPDATE poc_private.negotiations SET status=n.status,agreed_cents=n.agreed_cents,
    offered_cents=n.offered_cents,counter_rounds=n.counter_rounds,offer_id=gen_random_uuid() WHERE call_id=c.id;
  r:=jsonb_build_object('ok',true,'negotiation',poc_private.negotiation_view(c.id,c.authority_revision,p_load_id));
  INSERT INTO poc_private.offer_receipts(call_id,offer_id,fingerprint,result) VALUES(c.id,p_offer_id,fp,r);
  INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,
    CASE n.status WHEN 'failed' THEN 'negotiation_failed' WHEN 'agreed' THEN 'rate_agreed' ELSE 'negotiation_response' END,
    jsonb_build_object('loadId',p_load_id,'response',p_action,'requestedRate',p_amount_cents/100.0,
      'negotiation',r->'negotiation'));
  RETURN r;
END $$;


NOTIFY pgrst, 'reload schema';
COMMIT;
