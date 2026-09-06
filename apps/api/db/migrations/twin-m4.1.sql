-- Apply once after M4. No TMS mutation or manager notification is performed.
BEGIN;
ALTER TABLE public.poc_calls ADD COLUMN load_statuses jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN load_interest jsonb;

ALTER FUNCTION public.poc_call_action(text,text,uuid,text,text,jsonb,boolean) RENAME TO poc_call_action_m4;
ALTER FUNCTION public.poc_call_action_m4(text,text,uuid,text,text,jsonb,boolean) SET SCHEMA poc_private;
CREATE FUNCTION public.poc_call_action(p_session_hash text,p_action text,p_challenge uuid DEFAULT NULL,
 p_digest text DEFAULT NULL,p_recipient text DEFAULT NULL,p_metadata jsonb DEFAULT '{}'::jsonb,p_matches boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; r jsonb;
BEGIN
 SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
 IF c.load_interest IS NOT NULL AND p_action='authority_begin' THEN
  RETURN jsonb_build_object('ok',false,'error','INTEREST_ALREADY_RECORDED');
 END IF;
 r:=poc_private.poc_call_action_m4(p_session_hash,p_action,p_challenge,p_digest,p_recipient,p_metadata,p_matches);
 IF r->>'ok'='true' THEN
  IF p_action='authority_begin' THEN
   UPDATE public.poc_calls SET load_statuses='{}'::jsonb WHERE id=c.id;
  ELSIF p_action='save_loads' AND p_metadata->>'ok'='true' THEN
   IF jsonb_typeof(p_metadata->'loadStatuses')='object' THEN
    UPDATE public.poc_calls SET load_statuses=CASE WHEN p_metadata->>'command'='LOAD_QUERY'
      THEN p_metadata->'loadStatuses' ELSE load_statuses || (p_metadata->'loadStatuses') END WHERE id=c.id;
   END IF;
  END IF;
 END IF;
 SELECT * INTO c FROM public.poc_calls WHERE id=c.id;
 IF r ? 'session' THEN
  r:=jsonb_set(r,'{session}',(r->'session') || jsonb_build_object('loadInterest',c.load_interest));
 END IF;
 RETURN r;
END $$;

-- Retain all offer/carrier/round guards, additionally deny known non-open loads.
ALTER FUNCTION public.poc_negotiate(text,text,text,integer,bigint,bigint,uuid,bigint) RENAME TO poc_negotiate_m4;
ALTER FUNCTION public.poc_negotiate_m4(text,text,text,integer,bigint,bigint,uuid,bigint) SET SCHEMA poc_private;
CREATE FUNCTION public.poc_negotiate(p_session_hash text,p_action text,p_load_id text,p_revision integer DEFAULT NULL,
 p_listed_cents bigint DEFAULT NULL,p_max_cents bigint DEFAULT NULL,p_offer_id uuid DEFAULT NULL,p_amount_cents bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
 IF c.load_statuses ? p_load_id AND c.load_statuses->>p_load_id IS DISTINCT FROM 'OPEN' THEN
  RETURN jsonb_build_object('ok',false,'error','LOAD_UNAVAILABLE');
 END IF;
 RETURN poc_private.poc_negotiate_m4(p_session_hash,p_action,p_load_id,p_revision,p_listed_cents,p_max_cents,p_offer_id,p_amount_cents);
END $$;

CREATE FUNCTION public.poc_record_load_interest(p_session_hash text,p_load_id text,p_callback_number text,p_consent boolean,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; item jsonb;
BEGIN
 SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
 IF NOT FOUND OR c.session_expires_at<=now() THEN RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED'); END IF;
 IF NOT c.authority_passed OR NOT coalesce((c.authority_check->>'eligible')::boolean,false)
  THEN RETURN jsonb_build_object('ok',false,'error','AUTHORITY_REQUIRED'); END IF;
 IF c.otp_state<>'verified' THEN RETURN jsonb_build_object('ok',false,'error','OTP_REQUIRED'); END IF;
 IF c.authority_revision IS DISTINCT FROM p_revision THEN RETURN jsonb_build_object('ok',false,'error','CALL_CHANGED'); END IF;
 IF p_consent IS DISTINCT FROM true OR coalesce(p_callback_number,'') !~ '^\+[1-9][0-9]{6,14}$'
  THEN RETURN jsonb_build_object('ok',false,'error','INVALID_INTEREST_REQUEST'); END IF;
 IF c.load_interest IS NOT NULL THEN
  IF c.load_interest->>'load_id'=p_load_id AND c.load_interest->>'callback_number'=p_callback_number THEN
   RETURN jsonb_build_object('ok',true,'interest',c.load_interest,'replayed',true);
  END IF;
  RETURN jsonb_build_object('ok',false,'error','INTEREST_ALREADY_RECORDED');
 END IF;
 IF c.finalized_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error','CALL_FINALIZED'); END IF;
 IF c.booking IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error','BOOKING_ALREADY_ATTEMPTED'); END IF;
 IF NOT (c.available_load_ids ? p_load_id) THEN RETURN jsonb_build_object('ok',false,'error','LOAD_NOT_IN_CALL'); END IF;
 IF c.load_statuses->>p_load_id IS DISTINCT FROM 'PENDING' THEN RETURN jsonb_build_object('ok',false,'error','LOAD_STATUS_CHANGED'); END IF;
 item:=jsonb_build_object('reference',gen_random_uuid(),'load_id',p_load_id,'callback_number',p_callback_number,
  'status','recorded','requested_at',now(),'notification_sent',false,'callback_guaranteed',false);
 UPDATE public.poc_calls SET load_interest=item WHERE id=c.id;
 INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'load_interest_recorded',item || jsonb_build_object('consent',true,'authority_revision',c.authority_revision));
 RETURN jsonb_build_object('ok',true,'interest',item);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA poc_private FROM PUBLIC;
NOTIFY pgrst,'reload schema';
COMMIT;
