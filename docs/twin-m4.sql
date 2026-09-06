-- M4 additive migration. Apply once after m3.6. One attempt per call.
BEGIN;
ALTER TABLE public.poc_calls ADD COLUMN booking jsonb, ADD COLUMN booking_terms jsonb;
CREATE UNIQUE INDEX poc_booking_load_claim ON public.poc_calls ((booking->>'load_id'))
  WHERE booking->>'status' IN ('pending','confirmed','uncertain');

CREATE FUNCTION poc_private.booking_view(b jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN b->>'status'='pending' AND (b->>'attempted_at')::timestamptz < now()-interval '45 seconds'
   THEN b || '{"status":"uncertain","error":"BOOKING_RESULT_UNCONFIRMED","handoff_mock":false}'::jsonb ELSE b END
$$;

-- Keep M3 behavior; freeze the call's carrier/load once a booking was claimed.
ALTER FUNCTION public.poc_call_action(text,text,uuid,text,text,jsonb,boolean) RENAME TO poc_call_action_m3;
ALTER FUNCTION public.poc_call_action_m3(text,text,uuid,text,text,jsonb,boolean) SET SCHEMA poc_private;
CREATE FUNCTION public.poc_call_action(p_session_hash text,p_action text,p_challenge uuid DEFAULT NULL,
 p_digest text DEFAULT NULL,p_recipient text DEFAULT NULL,p_metadata jsonb DEFAULT '{}'::jsonb,p_matches boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; r jsonb;
BEGIN
 SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
 IF c.booking IS NOT NULL AND p_action NOT IN ('status','voice_failed') THEN
  RETURN jsonb_build_object('ok',false,'error','BOOKING_ALREADY_ATTEMPTED');
 END IF;
 r:=poc_private.poc_call_action_m3(p_session_hash,p_action,p_challenge,p_digest,p_recipient,p_metadata,p_matches);
 IF r ? 'session' THEN
  r:=jsonb_set(r,'{session}',(r->'session') || jsonb_build_object('booking',poc_private.booking_view(c.booking)));
 END IF;
 IF p_action='authority_begin' AND r->>'ok'='true' THEN
  UPDATE public.poc_calls SET booking_terms=NULL WHERE id=c.id;
 END IF;
 RETURN r;
END $$;

ALTER FUNCTION public.poc_negotiate(text,text,text,integer,bigint,bigint,uuid,bigint) RENAME TO poc_negotiate_m3;
ALTER FUNCTION public.poc_negotiate_m3(text,text,text,integer,bigint,bigint,uuid,bigint) SET SCHEMA poc_private;
CREATE FUNCTION public.poc_negotiate(p_session_hash text,p_action text,p_load_id text,p_revision integer DEFAULT NULL,
 p_listed_cents bigint DEFAULT NULL,p_max_cents bigint DEFAULT NULL,p_offer_id uuid DEFAULT NULL,p_amount_cents bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
 IF c.booking IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error','BOOKING_ALREADY_ATTEMPTED'); END IF;
 RETURN poc_private.poc_negotiate_m3(p_session_hash,p_action,p_load_id,p_revision,p_listed_cents,p_max_cents,p_offer_id,p_amount_cents);
END $$;

CREATE FUNCTION public.poc_book_call(p_session_hash text,p_action text,p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; n poc_private.negotiations%ROWTYPE; b jsonb; terms jsonb;
 result jsonb; state text; outcome text; mc text;
BEGIN
 SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED'); END IF;
 IF p_action='status' THEN RETURN jsonb_build_object('ok',true,'booking',poc_private.booking_view(c.booking)); END IF;
 IF p_action='complete' THEN
  -- Completion belongs to the claimed attempt even if the browser expired or
  -- the call finalized while the TMS request was in flight.
  IF c.booking IS NULL OR c.booking->>'attempt_id' IS DISTINCT FROM p_metadata->>'attemptId' THEN
   RETURN jsonb_build_object('ok',false,'error','BOOKING_ATTEMPT_CHANGED');
  END IF;
  IF c.booking->>'status' IN ('confirmed','rejected') THEN
   RETURN jsonb_build_object('ok',true,'booking',c.booking);
  END IF;
  result:=p_metadata->'result'; state:=result->>'status';
  IF c.booking->>'status'='uncertain' AND state='uncertain' AND c.booking->>'error'=result->>'error' THEN
   RETURN jsonb_build_object('ok',true,'booking',c.booking);
  END IF;
  IF state IS NULL OR state NOT IN ('confirmed','rejected','uncertain') THEN
   RETURN jsonb_build_object('ok',false,'error','INVALID_BOOKING_RESULT');
  END IF;
  IF state='confirmed' AND (coalesce(length(result->>'reference'),0) NOT BETWEEN 1 AND 128
    OR result->>'reference' ~ '[^ -~]' OR result->>'reference' ~ '[|]'
    OR coalesce(result->>'timestamp','') !~ '^[0-9]{14}$') THEN
   RETURN jsonb_build_object('ok',false,'error','INVALID_BOOKING_RESULT');
  END IF;
  b:=(c.booking-'error') || jsonb_build_object('status',state,'completed_at',now(),'handoff_mock',state='confirmed');
  IF state='confirmed' THEN
   b:=b || jsonb_build_object('reference',result->>'reference','tms_timestamp_utc',result->>'timestamp');
  ELSE
   b:=b || jsonb_build_object('error',CASE WHEN result->>'error' ~ '^[A-Z_]{1,64}$' THEN result->>'error' ELSE 'TMS_BOOKING_UNCERTAIN' END);
  END IF;
  UPDATE public.poc_calls SET booking=b WHERE id=c.id;
  INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'booking_'||state,b);
  IF state='confirmed' THEN
   INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'handoff_mock_recorded',
    jsonb_build_object('loadId',b->>'load_id','reference',b->>'reference','simulated',true));
  END IF;
  IF c.finalized_at IS NOT NULL THEN
   outcome:=CASE state WHEN 'confirmed' THEN 'booked' WHEN 'rejected' THEN 'booking_failed' ELSE 'booking_uncertain' END;
   UPDATE public.poc_calls SET final_outcome=outcome,
    final_result=jsonb_set(final_result,'{session}',(final_result->'session') || jsonb_build_object('booking',b,'finalOutcome',outcome)) WHERE id=c.id;
  END IF;
  RETURN jsonb_build_object('ok',true,'booking',b);
 END IF;
 IF c.session_expires_at<=now() THEN RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED'); END IF;
 IF c.booking IS NOT NULL THEN
  IF c.booking->>'load_id' IS DISTINCT FROM p_metadata->>'loadId'
   OR c.booking->>'offer_id' IS DISTINCT FROM p_metadata->>'offerId' THEN
   RETURN jsonb_build_object('ok',false,'error','BOOKING_ATTEMPT_CHANGED');
  END IF;
  RETURN jsonb_build_object('ok',true,'claimed',false,'booking',poc_private.booking_view(c.booking));
 END IF;
 IF c.finalized_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error','CALL_FINALIZED'); END IF;
 IF NOT c.authority_passed THEN RETURN jsonb_build_object('ok',false,'error','AUTHORITY_REQUIRED'); END IF;
 IF c.otp_state<>'verified' OR c.otp_verified_at IS NULL THEN RETURN jsonb_build_object('ok',false,'error','OTP_REQUIRED'); END IF;
 SELECT * INTO n FROM poc_private.negotiations WHERE call_id=c.id FOR UPDATE;
 IF n.call_id IS NULL OR n.load_id IS DISTINCT FROM c.selected_load_id
  OR n.load_id IS DISTINCT FROM p_metadata->>'loadId' OR NOT (c.available_load_ids ? n.load_id)
  OR n.authority_revision IS DISTINCT FROM c.authority_revision OR n.offer_id::text IS DISTINCT FROM p_metadata->>'offerId' THEN
  RETURN jsonb_build_object('ok',false,'error','OFFER_CHANGED');
 END IF;
 IF p_action='quote' THEN
  terms:=p_metadata->'terms';
  IF terms->>'LOAD_ID' IS DISTINCT FROM n.load_id OR terms->>'STATUS' IS DISTINCT FROM 'OPEN' THEN
   RETURN jsonb_build_object('ok',false,'error','INVALID_BOOKING_TERMS');
  END IF;
  IF n.status='offered' THEN
   -- A materially refreshed load needs a fresh offer identity as well as a
   -- snapshot. An acceptance of the previous equipment/schedule must fail.
   IF c.booking_terms IS NOT NULL AND c.booking_terms IS DISTINCT FROM terms THEN
    UPDATE poc_private.negotiations SET offer_id=gen_random_uuid() WHERE call_id=c.id;
   END IF;
   UPDATE public.poc_calls SET booking_terms=terms WHERE id=c.id;
  ELSIF n.status<>'agreed' OR c.booking_terms IS DISTINCT FROM terms THEN
   RETURN jsonb_build_object('ok',false,'error','BOOKING_TERMS_CHANGED');
  END IF;
  RETURN jsonb_build_object('ok',true,'negotiation',poc_private.negotiation_view(c.id,c.authority_revision,n.load_id));
 END IF;
 IF n.status<>'agreed' OR n.agreed_cents IS NULL OR n.agreed_cents>n.max_cents THEN
  RETURN jsonb_build_object('ok',false,'error','RATE_AGREEMENT_REQUIRED');
 END IF;
 IF p_action='preflight_failed' THEN
  INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'booking_preflight_failed',
   jsonb_build_object('loadId',n.load_id,'error',CASE WHEN p_metadata->>'error' ~ '^[A-Z_]{1,64}$' THEN p_metadata->>'error' ELSE 'TMS_UNAVAILABLE' END));
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF c.booking_terms IS NULL THEN RETURN jsonb_build_object('ok',false,'error','BOOKING_TERMS_REQUIRED'); END IF;
 IF p_action='prepare' THEN RETURN jsonb_build_object('ok',true); END IF;
 IF p_action<>'claim' THEN RETURN jsonb_build_object('ok',false,'error','INVALID_BOOKING_ACTION'); END IF;
 IF c.booking_terms IS DISTINCT FROM p_metadata->'terms'
  OR n.listed_cents IS DISTINCT FROM (p_metadata->>'listedCents')::bigint
  OR n.max_cents IS DISTINCT FROM (p_metadata->>'maxCents')::bigint THEN
  INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'booking_preflight_failed',
   jsonb_build_object('loadId',n.load_id,'error','BOOKING_TERMS_CHANGED'));
  RETURN jsonb_build_object('ok',false,'error','BOOKING_TERMS_CHANGED');
 END IF;
 mc:=c.authority_check->>'mcNumber';
 IF coalesce(mc,'') !~ '^[0-9]{1,8}$' OR coalesce(p_metadata->>'attemptId','') !~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
  RETURN jsonb_build_object('ok',false,'error','INVALID_BOOKING_REQUEST');
 END IF;
 -- Also prevent an uncertain attempt from being repeated through a NEW call.
 PERFORM pg_advisory_xact_lock(hashtextextended('poc-booking:'||n.load_id,0));
 IF EXISTS(SELECT 1 FROM public.poc_calls WHERE booking->>'load_id'=n.load_id AND booking->>'status' IN ('pending','confirmed','uncertain')) THEN
  RETURN jsonb_build_object('ok',false,'error','BOOKING_REVIEW_REQUIRED');
 END IF;
 b:=jsonb_build_object('status','pending','attempt_id',p_metadata->>'attemptId','load_id',n.load_id,
  'offer_id',n.offer_id,'mc_number',mc,'agreed_rate',n.agreed_cents/100.0,'attempted_at',now(),'handoff_mock',false);
 UPDATE public.poc_calls SET booking=b WHERE id=c.id;
 INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'booking_attempted',b);
 RETURN jsonb_build_object('ok',true,'claimed',true,'booking',b,'mcNumber',mc,'agreedCents',n.agreed_cents);
END $$;

-- Booking outcomes take precedence over the M3 agreement-only disposition.
CREATE OR REPLACE FUNCTION public.poc_finalize_call(p_session_hash text,p_outcome text,p_summary text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; n poc_private.negotiations%ROWTYPE; r jsonb; b jsonb;
BEGIN
 IF p_outcome IS NULL OR p_outcome NOT IN ('conversation_complete','caller_declined','technical_error')
  OR p_summary IS NULL OR length(trim(p_summary)) NOT BETWEEN 1 AND 1000 THEN
  RETURN jsonb_build_object('ok',false,'error','INVALID_FINALIZATION');
 END IF;
 SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
 IF NOT FOUND OR c.session_expires_at<=now() THEN RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED'); END IF;
 b:=poc_private.booking_view(c.booking);
 IF b->>'status'='pending' THEN RETURN jsonb_build_object('ok',false,'error','BOOKING_IN_PROGRESS'); END IF;
 SELECT * INTO n FROM poc_private.negotiations WHERE call_id=c.id;
 IF b IS NOT NULL THEN
  p_outcome:=CASE b->>'status' WHEN 'confirmed' THEN 'booked' WHEN 'rejected' THEN 'booking_failed' ELSE 'booking_uncertain' END;
 ELSIF n.status='failed' THEN p_outcome:='failed_negotiation';
 ELSIF n.status='agreed' THEN p_outcome:='rate_agreed'; END IF;
 IF c.finalized_at IS NOT NULL THEN
  IF c.final_outcome=p_outcome AND c.final_summary=p_summary THEN RETURN c.final_result; END IF;
  RETURN jsonb_build_object('ok',false,'error','CALL_ALREADY_FINALIZED');
 END IF;
 r:=public.poc_call_action(p_session_hash,'status');
 IF NOT coalesce((r->>'ok')::boolean,false) THEN RETURN r; END IF;
 r:=jsonb_set(r,'{session}',(r->'session') || jsonb_build_object('finalizedAt',now(),'finalOutcome',p_outcome,'booking',b));
 UPDATE public.poc_calls SET finalized_at=now(),final_outcome=p_outcome,final_summary=p_summary,final_result=r WHERE id=c.id;
 INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'call_finalized',jsonb_build_object(
  'outcome',p_outcome,'authorityPassed',c.authority_passed,'verified',r->'session'->'verified',
  'selectedLoadId',c.selected_load_id,'negotiation',r->'session'->'negotiation','booking',b,'bookingConfirmed',coalesce(b->>'status'='confirmed',false)));
 RETURN r;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA poc_private FROM PUBLIC;
NOTIFY pgrst,'reload schema';
COMMIT;
