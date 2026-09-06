-- Apply once after m3.2. Private pricing and idempotency receipts are not exposed
-- as public Twin tables. All writers lock the call first, then negotiation state.
BEGIN;
CREATE TABLE poc_private.negotiations (
  call_id uuid PRIMARY KEY REFERENCES public.poc_calls(id),
  authority_revision integer NOT NULL,
  load_id text NOT NULL,
  offer_id uuid NOT NULL DEFAULT gen_random_uuid(),
  listed_cents bigint NOT NULL CHECK (listed_cents > 0),
  max_cents bigint NOT NULL CHECK (max_cents >= listed_cents),
  offered_cents bigint NOT NULL CHECK (offered_cents > 0 AND offered_cents <= max_cents),
  agreed_cents bigint CHECK (agreed_cents > 0 AND agreed_cents <= max_cents),
  counter_rounds integer NOT NULL DEFAULT 0 CHECK (counter_rounds BETWEEN 0 AND 3),
  status text NOT NULL DEFAULT 'offered' CHECK (status IN ('idle','offered','agreed','rejected','failed')),
  expires_at timestamptz NOT NULL
);
CREATE TABLE poc_private.offer_receipts (
  call_id uuid NOT NULL REFERENCES public.poc_calls(id),
  offer_id uuid NOT NULL,
  fingerprint jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (call_id,offer_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA poc_private FROM PUBLIC;

CREATE FUNCTION poc_private.negotiation_view(p_call_id uuid,p_revision integer,p_selected text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN n.status='failed' OR (n.authority_revision=p_revision AND n.load_id=p_selected AND n.status<>'idle')
    THEN jsonb_build_object('status',n.status,'load_id',n.load_id,'offer_id',n.offer_id,
      'offered_rate',CASE WHEN n.status IN ('offered','agreed') THEN n.offered_cents/100.0 ELSE NULL END,
      'agreed_rate',n.agreed_cents/100.0,'counter_rounds',n.counter_rounds,
      'rounds_remaining',3-n.counter_rounds,'expires_at',n.expires_at,'booking_confirmed',false)
    ELSE jsonb_build_object('status','idle','counter_rounds',n.counter_rounds,
      'rounds_remaining',3-n.counter_rounds,'booking_confirmed',false) END
  FROM poc_private.negotiations n WHERE n.call_id=p_call_id;
$$;

CREATE OR REPLACE FUNCTION public.poc_call_action(
  p_session_hash text,p_action text,p_challenge uuid DEFAULT NULL,
  p_digest text DEFAULT NULL,p_recipient text DEFAULT NULL,p_metadata jsonb DEFAULT '{}'::jsonb,
  p_matches boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; n poc_private.negotiations%ROWTYPE; r jsonb;
BEGIN
  IF p_action='issue' AND p_recipient IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_recipient,0));
  END IF;
  SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
  IF NOT FOUND OR c.session_expires_at<=now() THEN RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED'); END IF;
  IF c.finalized_at IS NOT NULL AND p_action NOT IN ('status','voice_failed') THEN
    RETURN jsonb_build_object('ok',false,'error','CALL_FINALIZED');
  END IF;
  SELECT * INTO n FROM poc_private.negotiations WHERE call_id=c.id;
  IF p_action IN ('authorize_load','save_loads') THEN
    IF n.status='failed' THEN RETURN jsonb_build_object('ok',false,'error','NEGOTIATION_FAILED'); END IF;
    IF n.status='agreed' AND (p_metadata->>'command' IS DISTINCT FROM 'LOAD_GET'
      OR p_metadata->>'loadId' IS DISTINCT FROM n.load_id) THEN
      RETURN jsonb_build_object('ok',false,'error','NEGOTIATION_COMPLETE');
    END IF;
  END IF;
  r:=poc_private.poc_call_action(p_session_hash,p_action,p_challenge,p_digest,p_recipient,p_metadata,p_matches);
  IF p_action='authority_begin' AND r->>'ok'='true' THEN
    -- A changed carrier loses the agreement, but never regains spent rounds.
    UPDATE poc_private.negotiations SET status=CASE WHEN status='failed' THEN 'failed' ELSE 'idle' END,
      agreed_cents=NULL,offer_id=gen_random_uuid() WHERE call_id=c.id;
  END IF;
  SELECT * INTO c FROM public.poc_calls WHERE id=c.id;
  IF r ? 'session' THEN
    r:=jsonb_set(r,'{session}',(r->'session') || jsonb_build_object('finalizedAt',c.finalized_at,
      'finalOutcome',c.final_outcome,'negotiation',poc_private.negotiation_view(c.id,c.authority_revision,c.selected_load_id)));
  END IF;
  RETURN r;
END $$;

CREATE FUNCTION public.poc_negotiate(
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
  IF c.otp_state<>'verified' OR c.otp_verified_at IS NULL OR c.otp_verified_at+interval '5 minutes'<=now() THEN
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

CREATE OR REPLACE FUNCTION public.poc_finalize_call(p_session_hash text,p_outcome text,p_summary text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; n poc_private.negotiations%ROWTYPE; r jsonb;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('conversation_complete','caller_declined','technical_error')
    OR p_summary IS NULL OR length(trim(p_summary)) NOT BETWEEN 1 AND 1000 THEN
    RETURN jsonb_build_object('ok',false,'error','INVALID_FINALIZATION');
  END IF;
  SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
  IF NOT FOUND OR c.session_expires_at<=now() THEN RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED'); END IF;
  SELECT * INTO n FROM poc_private.negotiations WHERE call_id=c.id;
  -- Outcome is factual and backend-derived, even if the model supplies another label.
  IF n.status='failed' THEN p_outcome:='failed_negotiation';
  ELSIF n.status='agreed' THEN p_outcome:='rate_agreed'; END IF;
  IF c.finalized_at IS NOT NULL THEN
    IF c.final_outcome=p_outcome AND c.final_summary=p_summary THEN RETURN c.final_result; END IF;
    RETURN jsonb_build_object('ok',false,'error','CALL_ALREADY_FINALIZED');
  END IF;
  r:=public.poc_call_action(p_session_hash,'status');
  IF NOT coalesce((r->>'ok')::boolean,false) THEN RETURN r; END IF;
  r:=jsonb_set(r,'{session}',(r->'session') || jsonb_build_object('finalizedAt',now(),'finalOutcome',p_outcome));
  UPDATE public.poc_calls SET finalized_at=now(),final_outcome=p_outcome,final_summary=p_summary,final_result=r WHERE id=c.id;
  INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'call_finalized',jsonb_build_object(
    'outcome',p_outcome,'authorityPassed',c.authority_passed,'verified',r->'session'->'verified',
    'selectedLoadId',c.selected_load_id,'negotiation',r->'session'->'negotiation','bookingConfirmed',false));
  RETURN r;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
