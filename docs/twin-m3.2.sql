-- Apply once after twin-m3.1.sql. Preserve the tested state machine and wrap it
-- with a terminal-state guard; keep the legacy helper outside the REST schema.
BEGIN;
ALTER TABLE public.poc_calls ADD COLUMN finalized_at timestamptz,
  ADD COLUMN final_outcome text, ADD COLUMN final_summary text,
  ADD COLUMN final_result jsonb;
CREATE SCHEMA IF NOT EXISTS poc_private;
REVOKE ALL ON SCHEMA poc_private FROM PUBLIC;
ALTER FUNCTION public.poc_call_action(text,text,uuid,text,text,jsonb,boolean) SET SCHEMA poc_private;

CREATE FUNCTION public.poc_call_action(
  p_session_hash text, p_action text, p_challenge uuid DEFAULT NULL,
  p_digest text DEFAULT NULL, p_recipient text DEFAULT NULL, p_metadata jsonb DEFAULT '{}'::jsonb,
  p_matches boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; r jsonb;
BEGIN
  -- Preserve the original advisory-lock-before-row-lock ordering for sends.
  IF p_action='issue' AND p_recipient IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_recipient,0));
  END IF;
  SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
  IF NOT FOUND OR c.session_expires_at <= now() THEN
    RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED');
  END IF;
  IF c.finalized_at IS NOT NULL AND p_action NOT IN ('status','voice_failed') THEN
    RETURN jsonb_build_object('ok',false,'error','CALL_FINALIZED');
  END IF;
  r := poc_private.poc_call_action(p_session_hash,p_action,p_challenge,p_digest,p_recipient,p_metadata,p_matches);
  IF r ? 'session' THEN
    r := jsonb_set(r,'{session}',(r->'session') || jsonb_build_object('finalizedAt',c.finalized_at,'finalOutcome',c.final_outcome));
  END IF;
  RETURN r;
END $$;

CREATE FUNCTION public.poc_finalize_call(p_session_hash text,p_outcome text,p_summary text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; r jsonb;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('conversation_complete','caller_declined','technical_error')
    OR p_summary IS NULL OR length(trim(p_summary)) NOT BETWEEN 1 AND 1000 THEN
    RETURN jsonb_build_object('ok',false,'error','INVALID_FINALIZATION');
  END IF;
  SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
  IF NOT FOUND OR c.session_expires_at <= now() THEN
    RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED');
  END IF;
  IF c.finalized_at IS NOT NULL THEN
    IF c.final_outcome=p_outcome AND c.final_summary=p_summary THEN RETURN c.final_result; END IF;
    RETURN jsonb_build_object('ok',false,'error','CALL_ALREADY_FINALIZED');
  END IF;
  r := public.poc_call_action(p_session_hash,'status');
  IF NOT coalesce((r->>'ok')::boolean,false) THEN RETURN r; END IF;
  r := jsonb_set(r,'{session}',(r->'session') || jsonb_build_object('finalizedAt',now(),'finalOutcome',p_outcome));
  UPDATE public.poc_calls SET finalized_at=now(),final_outcome=p_outcome,
    final_summary=p_summary,final_result=r WHERE id=c.id;
  INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'call_finalized',jsonb_build_object(
    'outcome',p_outcome,'authorityPassed',c.authority_passed,
    'verified',r->'session'->'verified','selectedLoadId',c.selected_load_id,'bookingConfirmed',false));
  RETURN r;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
