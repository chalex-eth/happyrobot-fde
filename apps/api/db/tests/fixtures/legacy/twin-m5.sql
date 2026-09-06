-- Additive M5: operator projections, review queue and durable call activity.
BEGIN;
ALTER TABLE public.poc_calls ADD COLUMN source text NOT NULL DEFAULT 'unknown',
 ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN reported_end_reason text, ADD COLUMN ended_at timestamptz,
 ADD COLUMN end_evidence text, ADD COLUMN load_snapshots jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE poc_private.operator_access(key_hash text PRIMARY KEY);
CREATE TABLE public.poc_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), call_id uuid NOT NULL REFERENCES public.poc_calls(id),
 reason text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewed')),
 detail text NOT NULL, callback_number text, source_key text NOT NULL,
 revision uuid NOT NULL DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), resolution_note text, reviewed_at timestamptz,
 UNIQUE(call_id,reason)
);
CREATE INDEX poc_reviews_open ON public.poc_reviews(updated_at DESC) WHERE status='open';
CREATE INDEX poc_calls_recent ON public.poc_calls(created_at DESC,id);
REVOKE ALL ON public.poc_reviews FROM PUBLIC;

CREATE FUNCTION poc_private.raise_review(cid uuid, why text, detail text, source_key text, phone text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO public.poc_reviews(call_id,reason,detail,source_key,callback_number)
 VALUES(cid,why,left(detail,500),source_key,phone)
 ON CONFLICT(call_id,reason) DO UPDATE SET status='open',detail=EXCLUDED.detail,
 callback_number=coalesce(EXCLUDED.callback_number,poc_reviews.callback_number),source_key=EXCLUDED.source_key,
 revision=gen_random_uuid(),updated_at=now(),reviewed_at=NULL,resolution_note=NULL
 WHERE poc_reviews.source_key IS DISTINCT FROM EXCLUDED.source_key;
END $$;

-- Existing M3/M4 code paths become observable without changing their results.
CREATE FUNCTION poc_private.capture_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.authority_check IS DISTINCT FROM OLD.authority_check AND NEW.authority_check->>'outcome'='unverified' THEN
  PERFORM poc_private.raise_review(NEW.id,'technical_error','Carrier authority lookup could not be completed.',NEW.authority_check::text);
 END IF;
 IF NEW.load_interest IS DISTINCT FROM OLD.load_interest AND NEW.load_interest IS NOT NULL THEN
  PERFORM poc_private.raise_review(NEW.id,'callback_requested','Callback requested about pending load '||(NEW.load_interest->>'load_id'),NEW.load_interest->>'reference',NEW.load_interest->>'callback_number');
 END IF;
 IF NEW.booking IS DISTINCT FROM OLD.booking AND NEW.booking->>'status' IN ('uncertain','rejected') THEN
  PERFORM poc_private.raise_review(NEW.id,CASE NEW.booking->>'status' WHEN 'uncertain' THEN 'booking_uncertain' ELSE 'booking_failed' END,
   coalesce(NEW.booking->>'error','Booking needs review'),NEW.booking->>'attempt_id');
 END IF;
 IF NEW.final_outcome IS DISTINCT FROM OLD.final_outcome AND NEW.final_outcome='technical_error' THEN
  PERFORM poc_private.raise_review(NEW.id,'technical_error','Call ended with a technical error.','finalization');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER poc_capture_review AFTER UPDATE ON public.poc_calls FOR EACH ROW EXECUTE FUNCTION poc_private.capture_review();

-- Snapshot only public fields; no raw events or private negotiation pricing leave Twin.
CREATE FUNCTION poc_private.public_load(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each(coalesce(v,'{}'))
 WHERE key IN ('LOAD_ID','ORIG_CITY','ORIG_STATE','ORIG_ZIP','DEST_CITY','DEST_STATE','DEST_ZIP','PICKUP_DT','DELIVERY_DT','EQTYPE','RATE','MILES','STATUS','WEIGHT','PIECES')
$$;
CREATE FUNCTION public.poc_track_call(p_session_hash text,p_action text,p_metadata jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; item jsonb; tool text; fault text;
BEGIN
 SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','SESSION_REQUIRED'); END IF;
 IF p_action='source' AND p_metadata->>'source' IN ('browser_demo','evaluation','integration_test') THEN
  UPDATE public.poc_calls SET source=p_metadata->>'source' WHERE id=c.id AND source='unknown';
 ELSIF p_action='loads' THEN
  FOR item IN SELECT value FROM jsonb_array_elements(p_metadata->'records') LOOP
   IF item->>'LOAD_ID' ~ '^[A-Za-z0-9_-]{1,64}$' THEN
    UPDATE public.poc_calls SET load_snapshots=jsonb_set(load_snapshots,ARRAY[item->>'LOAD_ID'],poc_private.public_load(item)) WHERE id=c.id;
   END IF;
  END LOOP;
 ELSIF p_action='disconnected' THEN
  IF c.finalized_at IS NULL THEN PERFORM poc_private.raise_review(c.id,'missing_finalization','Browser audio disconnected without a saved ending. Check the provider run.','audio-disconnected'); END IF;
 ELSIF p_action='ended' THEN
  UPDATE public.poc_calls SET ended_at=coalesce(ended_at,now()),end_evidence='provider_cancel_acknowledged' WHERE id=c.id;
 ELSIF p_action='tool' THEN
  tool:=p_metadata->>'tool'; fault:=p_metadata->>'error';
  IF tool !~ '^[a-z_]{1,50}$' OR coalesce(p_metadata->>'requestId','') !~ '^[0-9a-f-]{36}$' THEN
   RETURN jsonb_build_object('ok',false,'error','INVALID_ACTIVITY');
  END IF;
  -- Same HTTP invocation can be recorded again without duplicate events.
  IF NOT EXISTS(SELECT 1 FROM public.poc_call_events WHERE call_id=c.id AND event='tool_result' AND metadata->>'requestId'=p_metadata->>'requestId') THEN
   INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'tool_result',jsonb_build_object(
    'tool',tool,'ok',p_metadata->'ok','error',CASE WHEN fault ~ '^[A-Z_0-9]{1,80}$' THEN fault END,'requestId',p_metadata->>'requestId'));
   IF p_metadata->>'ok'='false' AND fault NOT IN ('OTP_INVALID','OTP_FAILED','AUTHORITY_REQUIRED','OTP_REQUIRED','CALL_FINALIZED','NEGOTIATION_COMPLETE','NEGOTIATION_FAILED','OFFER_ALREADY_ANSWERED','OFFER_CHANGED','OFFER_EXPIRED') THEN
    PERFORM poc_private.raise_review(c.id,'technical_error',tool||': '||coalesce(fault,'TOOL_UNAVAILABLE'),p_metadata->>'requestId');
   END IF;
  END IF;
 ELSE RETURN jsonb_build_object('ok',false,'error','INVALID_ACTIVITY'); END IF;
 UPDATE public.poc_calls SET last_activity_at=now() WHERE id=c.id;
 RETURN jsonb_build_object('ok',true);
END $$;

-- Extend finalization with optional operator follow-up. The old business rules
-- still derive the outcome; the supplied ending is retained separately.
ALTER FUNCTION public.poc_finalize_call(text,text,text) RENAME TO poc_finalize_call_m4;
ALTER FUNCTION public.poc_finalize_call_m4(text,text,text) SET SCHEMA poc_private;
CREATE FUNCTION public.poc_finalize_call(p_session_hash text,p_outcome text,p_summary text,p_review jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r jsonb; c public.poc_calls%ROWTYPE; why text; phone text; note text;
BEGIN
 why:=p_review->>'reason'; phone:=p_review->>'callback_number'; note:=p_review->>'note';
 IF why IS NOT NULL AND (why NOT IN ('callback_requested','human_requested','other') OR coalesce(length(trim(note)),0) NOT BETWEEN 1 AND 500) THEN
  RETURN jsonb_build_object('ok',false,'error','INVALID_REVIEW');
 END IF;
 IF why='callback_requested' AND (coalesce(phone,'') !~ '^\+[1-9][0-9]{6,14}$' OR p_review->>'consent' IS DISTINCT FROM 'true') THEN
  RETURN jsonb_build_object('ok',false,'error','CALLBACK_CONSENT_REQUIRED');
 END IF;
 IF why IS NULL AND p_review<>'{}'::jsonb THEN RETURN jsonb_build_object('ok',false,'error','INVALID_REVIEW'); END IF;
 SELECT * INTO c FROM public.poc_calls WHERE session_hash=p_session_hash FOR UPDATE;
 IF c.finalized_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.poc_call_events WHERE call_id=c.id AND event='finalization_report' AND metadata->'review'=p_review) AND
    (p_review<>'{}'::jsonb OR EXISTS(SELECT 1 FROM public.poc_call_events WHERE call_id=c.id AND event='finalization_report')) THEN
  RETURN jsonb_build_object('ok',false,'error','CALL_ALREADY_FINALIZED');
 END IF;
 r:=poc_private.poc_finalize_call_m4(p_session_hash,p_outcome,p_summary);
 IF r->>'ok' IS DISTINCT FROM 'true' THEN RETURN r; END IF;
 UPDATE public.poc_calls SET reported_end_reason=coalesce(reported_end_reason,p_outcome),last_activity_at=now() WHERE id=c.id;
 IF c.finalized_at IS NULL THEN
  INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'finalization_report',jsonb_build_object('reported_end_reason',p_outcome,'review',p_review));
 END IF;
 IF p_outcome='technical_error' AND c.finalized_at IS NULL THEN PERFORM poc_private.raise_review(c.id,'technical_error','Call ended with a technical error.','finalization'); END IF;
 IF why IS NOT NULL THEN
  PERFORM poc_private.raise_review(c.id,why,note,'finalization',CASE WHEN why='callback_requested' THEN phone END);
  IF NOT EXISTS(SELECT 1 FROM public.poc_call_events WHERE call_id=c.id AND event='review_requested') THEN
   INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(c.id,'review_requested',p_review);
  END IF;
 END IF;
 RETURN r || jsonb_build_object('review_recorded',why IS NOT NULL);
END $$;

CREATE FUNCTION poc_private.operator_call(cid uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',c.id,'created_at',c.created_at,'source',c.source,'last_activity_at',c.last_activity_at,
 'mc',c.authority_check->>'mcNumber','carrier',c.authority_check#>>'{carrier,legalName}',
 'authority_passed',c.authority_passed,'verified',c.otp_state='verified','run_id',c.voice_run_id,
 'finalized_at',c.finalized_at,'outcome',c.final_outcome,'summary',c.final_summary,
 'reported_end_reason',c.reported_end_reason,'ended_at',c.ended_at,'end_evidence',c.end_evidence,
 'selected_load_id',c.selected_load_id,'load',poc_private.public_load(coalesce(c.load_snapshots->c.selected_load_id,c.booking_terms,'{}')),
 'negotiation',poc_private.negotiation_view(c.id,c.authority_revision,c.selected_load_id),
 'booking',poc_private.booking_view(c.booking),'interest',c.load_interest,
 'reviews',coalesce((SELECT jsonb_agg(to_jsonb(r)-'source_key' ORDER BY r.created_at) FROM public.poc_reviews r WHERE r.call_id=c.id),'[]'))
 FROM public.poc_calls c WHERE c.id=cid
$$;
CREATE FUNCTION public.poc_operator(p_key text,p_action text,p_metadata jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cid uuid; rid uuid; rev uuid; r public.poc_reviews%ROWTYPE; payload jsonb; total integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM poc_private.operator_access WHERE key_hash=encode(sha256(convert_to(p_key,'UTF8')),'hex')) THEN
  RETURN jsonb_build_object('ok',false,'error','OPERATOR_AUTH_REQUIRED');
 END IF;
 IF p_action IN ('list','detail') THEN
  -- A timeout is a review signal, not a declaration that the call ended.
  INSERT INTO public.poc_reviews(call_id,reason,detail,source_key)
  SELECT id,'missing_finalization','Call has no saved ending. Check the provider run.','missing-finalization'
  FROM public.poc_calls WHERE finalized_at IS NULL AND voice_run_id IS NOT NULL
   AND (session_expires_at<now() OR ended_at IS NOT NULL)
  ON CONFLICT(call_id,reason) DO NOTHING;
  INSERT INTO public.poc_reviews(call_id,reason,detail,source_key)
  SELECT id,'booking_uncertain','Booking attempt has no confirmed result. Do not retry.',booking->>'attempt_id'
  FROM public.poc_calls WHERE booking->>'status'='pending' AND (booking->>'attempted_at')::timestamptz<now()-interval '45 seconds'
  ON CONFLICT(call_id,reason) DO NOTHING;
 END IF;
 IF p_action='list' THEN
  SELECT count(*) INTO total FROM public.poc_calls c WHERE
   (coalesce(p_metadata->>'source','all')='all' OR c.source=p_metadata->>'source') AND
   (coalesce(p_metadata->>'review','false')<>'true' OR EXISTS(SELECT 1 FROM public.poc_reviews rv WHERE rv.call_id=c.id AND rv.status='open')) AND
   (coalesce(p_metadata->>'query','')='' OR c.authority_check->>'mcNumber' ILIKE '%'||(p_metadata->>'query')||'%' OR c.selected_load_id ILIKE '%'||(p_metadata->>'query')||'%');
  SELECT coalesce(jsonb_agg(poc_private.operator_call(id) ORDER BY created_at DESC,id),'[]') INTO payload FROM
  (SELECT c.id,c.created_at FROM public.poc_calls c WHERE
   (coalesce(p_metadata->>'source','all')='all' OR c.source=p_metadata->>'source') AND
   (coalesce(p_metadata->>'review','false')<>'true' OR EXISTS(SELECT 1 FROM public.poc_reviews rv WHERE rv.call_id=c.id AND rv.status='open')) AND
   (coalesce(p_metadata->>'query','')='' OR c.authority_check->>'mcNumber' ILIKE '%'||(p_metadata->>'query')||'%' OR c.selected_load_id ILIKE '%'||(p_metadata->>'query')||'%')
   ORDER BY c.created_at DESC,c.id LIMIT 30 OFFSET least(greatest(coalesce((p_metadata->>'offset')::int,0),0),10000)) c;
  RETURN jsonb_build_object('ok',true,'calls',payload,'total',total,'review_count',(SELECT count(DISTINCT call_id) FROM public.poc_reviews WHERE status='open'));
 ELSIF p_action='detail' THEN
  cid:=(p_metadata->>'call_id')::uuid;
  SELECT jsonb_agg(jsonb_build_object('id',id,'event',event,'created_at',created_at,'data',
    coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(e.metadata) WHERE key IN
     ('tool','ok','error','reason','outcome','loadId','load_id','command','response','amount','requestedRate','offered_rate','agreed_rate','counter_rounds','status','reference','simulated','note','resolution_note','callback_number','consent')),'{}') || jsonb_strip_nulls(jsonb_build_object('offered_rate',e.metadata#>'{negotiation,offered_rate}','agreed_rate',e.metadata#>'{negotiation,agreed_rate}','counter_rounds',e.metadata#>'{negotiation,counter_rounds}'))) ORDER BY id)
   INTO payload FROM public.poc_call_events e WHERE call_id=cid;
  RETURN jsonb_build_object('ok',true,'call',poc_private.operator_call(cid),'events',coalesce(payload,'[]'));
 ELSIF p_action='review' THEN
  rid:=(p_metadata->>'id')::uuid; rev:=(p_metadata->>'revision')::uuid;
  IF coalesce(length(trim(p_metadata->>'note')),0) NOT BETWEEN 1 AND 500 OR p_metadata->>'status' NOT IN ('open','reviewed') THEN
   RETURN jsonb_build_object('ok',false,'error','INVALID_REVIEW'); END IF;
  SELECT * INTO r FROM public.poc_reviews WHERE id=rid FOR UPDATE;
  IF r.id IS NULL OR r.revision<>rev THEN RETURN jsonb_build_object('ok',false,'error','REVIEW_CHANGED'); END IF;
  UPDATE public.poc_reviews SET status=p_metadata->>'status',resolution_note=p_metadata->>'note',
   reviewed_at=CASE WHEN p_metadata->>'status'='reviewed' THEN now() END,updated_at=now(),revision=gen_random_uuid() WHERE id=rid;
  INSERT INTO public.poc_call_events(call_id,event,metadata) VALUES(r.call_id,'operator_review',
   jsonb_build_object('reason',r.reason,'status',p_metadata->>'status','resolution_note',p_metadata->>'note'));
  RETURN jsonb_build_object('ok',true);
 END IF;
 RETURN jsonb_build_object('ok',false,'error','INVALID_OPERATOR_ACTION');
END $$;
-- Backfill only known facts. Historical provenance/end reasons remain unknown.
SELECT poc_private.raise_review(id,'technical_error','Carrier authority lookup could not be completed.',authority_check::text) FROM public.poc_calls WHERE authority_check->>'outcome'='unverified';
SELECT poc_private.raise_review(call_id,'technical_error','Recorded tool failure: '||(metadata->>'error'),'historical-error-'||id::text) FROM public.poc_call_events WHERE metadata->>'error' ~ '(UNAVAILABLE|TIMEOUT|CONNECTION|MALFORMED|FAILED|UNCERTAIN)' AND metadata->>'error' NOT IN ('OTP_FAILED','NEGOTIATION_FAILED') ORDER BY id;
SELECT poc_private.raise_review(id,'callback_requested','Callback requested about pending load '||(load_interest->>'load_id'),load_interest->>'reference',load_interest->>'callback_number') FROM public.poc_calls WHERE load_interest IS NOT NULL;
SELECT poc_private.raise_review(id,'technical_error','Call ended with a technical error.','finalization') FROM public.poc_calls WHERE final_outcome='technical_error';
SELECT poc_private.raise_review(id,CASE booking->>'status' WHEN 'uncertain' THEN 'booking_uncertain' ELSE 'booking_failed' END,coalesce(booking->>'error','Booking needs review'),booking->>'attempt_id') FROM public.poc_calls WHERE booking->>'status' IN ('uncertain','rejected');
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA poc_private FROM PUBLIC;
NOTIFY pgrst,'reload schema';
COMMIT;
