BEGIN;
DO $$
DECLARE h text:=repeat('a',64);cid uuid:=gen_random_uuid();r jsonb;replay jsonb;rid uuid;rev uuid;n int;
BEGIN
 INSERT INTO poc_private.operator_access VALUES(encode(sha256(convert_to('test-only-key','UTF8')),'hex'));
 ASSERT public.poc_operator('wrong','list')->>'error'='OPERATOR_AUTH_REQUIRED';
 PERFORM public.poc_start_call(cid,h);
 r:=public.poc_finalize_call(h,'conversation_complete','Caller wants a callback.','{"reason":"callback_requested","note":"Call tomorrow","callback_number":"+12125550123","consent":false}');
 ASSERT r->>'error'='CALLBACK_CONSENT_REQUIRED';
 ASSERT (SELECT finalized_at IS NULL FROM public.poc_calls WHERE id=cid);
 r:=public.poc_finalize_call(h,'conversation_complete','Caller wants a callback.','{"reason":"callback_requested","note":"Call tomorrow","callback_number":"+12125550123","consent":true}');
 ASSERT r->>'review_recorded'='true';
 replay:=public.poc_finalize_call(h,'conversation_complete','Caller wants a callback.','{"reason":"callback_requested","note":"Call tomorrow","callback_number":"+12125550123","consent":true}');
 ASSERT r=replay;
 ASSERT (SELECT count(*)=1 FROM public.poc_reviews WHERE call_id=cid);
 ASSERT public.poc_finalize_call(h,'conversation_complete','Caller wants a callback.')->>'error'='CALL_ALREADY_FINALIZED';
 SELECT id,revision INTO rid,rev FROM public.poc_reviews WHERE call_id=cid;
 r:=public.poc_operator('test-only-key','review',jsonb_build_object('id',rid,'revision',rev,'status','reviewed','note','Callback completed by operator.'));
 ASSERT r->>'ok'='true';
 ASSERT (SELECT status='reviewed' FROM public.poc_reviews WHERE id=rid);
 ASSERT public.poc_operator('test-only-key','review',jsonb_build_object('id',rid,'revision',rev,'status','reviewed','note','Stale note'))->>'error'='REVIEW_CHANGED';
 ASSERT (SELECT final_outcome='conversation_complete' AND booking IS NULL FROM public.poc_calls WHERE id=cid);
 -- Successful replay does not reopen an already reviewed callback.
 PERFORM public.poc_finalize_call(h,'conversation_complete','Caller wants a callback.','{"reason":"callback_requested","note":"Call tomorrow","callback_number":"+12125550123","consent":true}');
 ASSERT (SELECT status='reviewed' FROM public.poc_reviews WHERE id=rid);
 -- Technical failure is durable even after an agreement is saved.
 h:=repeat('b',64);cid:=gen_random_uuid();PERFORM public.poc_start_call(cid,h);
 UPDATE public.poc_calls SET booking='{"status":"confirmed","attempt_id":"b","load_id":"TEST","agreed_rate":1000,"reference":"MOCK-1","simulated":true,"handoff_mock":true}',otp_digest=repeat('c',64) WHERE id=cid;
 r:=public.poc_finalize_call(h,'technical_error','Audio failed after booking.');
 ASSERT r->'session'->>'finalOutcome'='booking_simulated';
 ASSERT (SELECT reported_end_reason='technical_error' FROM public.poc_calls WHERE id=cid);
 ASSERT EXISTS(SELECT 1 FROM public.poc_reviews WHERE call_id=cid AND reason='technical_error');
 r:=public.poc_operator('test-only-key','detail',jsonb_build_object('call_id',cid));
 ASSERT r::text NOT LIKE '%otp_digest%' AND r::text NOT LIKE '%session_hash%' AND r::text NOT LIKE '%max_cents%' AND r::text NOT LIKE '%MAX_BUY%';
 -- Track public lane snapshots and idempotent, safe failure events.
 h:=repeat('d',64);cid:=gen_random_uuid();PERFORM public.poc_start_call(cid,h);
 PERFORM public.poc_track_call(h,'loads','{"records":[{"LOAD_ID":"T1","ORIG_CITY":"Salt Lake City","MAX_BUY":"SECRET"}]}');
 ASSERT (SELECT load_snapshots::text NOT LIKE '%SECRET%' FROM public.poc_calls WHERE id=cid);
 PERFORM public.poc_track_call(h,'tool','{"tool":"search_loads","ok":false,"error":"TMS_TIMEOUT","requestId":"11111111-1111-4111-8111-111111111111"}');
 PERFORM public.poc_track_call(h,'tool','{"tool":"search_loads","ok":false,"error":"TMS_TIMEOUT","requestId":"11111111-1111-4111-8111-111111111111"}');
 ASSERT (SELECT count(*)=1 FROM public.poc_call_events WHERE call_id=cid AND event='tool_result');
 UPDATE public.poc_calls SET voice_run_id='11111111-1111-4111-8111-111111111111',session_expires_at=now()-interval '1 minute' WHERE id=cid;
 r:=public.poc_operator('test-only-key','list');
 ASSERT EXISTS(SELECT 1 FROM public.poc_reviews WHERE call_id=cid AND reason='missing_finalization');
 ASSERT (SELECT finalized_at IS NULL FROM public.poc_calls WHERE id=cid);
 -- Voice creation can fail before a provider run is bound.
 h:=repeat('e',64);cid:=gen_random_uuid();PERFORM public.poc_start_call(cid,h);
 PERFORM public.poc_call_action(h,'voice_reserve');
 PERFORM public.poc_call_action(h,'voice_failed');
 ASSERT EXISTS(SELECT 1 FROM public.poc_reviews WHERE call_id=cid AND reason='technical_error');
 RAISE NOTICE 'PASS: operator auth, callback consent, finalization replay, review concurrency, technical outcome preservation, safe projection and missing-ending review';
END $$;
ROLLBACK;
