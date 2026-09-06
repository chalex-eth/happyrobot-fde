-- Disposable PostgreSQL only. Fixtures and assertions roll back.
BEGIN;
DO $$
DECLARE h text:=repeat('b',64); cid uuid:=gen_random_uuid(); r jsonb; first jsonb; n jsonb;
BEGIN
 PERFORM public.poc_start_call(cid,h);
 ASSERT public.poc_record_load_interest(h,'P1','+12125550123',true,0)->>'error'='AUTHORITY_REQUIRED';
 UPDATE public.poc_calls SET authority_passed=true,authority_revision=1,
  authority_check='{"eligible":true,"outcome":"eligible","mcNumber":"1515"}' WHERE id=cid;
 ASSERT public.poc_record_load_interest(h,'P1','+12125550123',true,1)->>'error'='OTP_REQUIRED';
 UPDATE public.poc_calls SET otp_state='verified',otp_verified_at=now() WHERE id=cid;
 PERFORM public.poc_call_action(h,'save_loads',p_metadata:='{"command":"LOAD_QUERY","revision":1,"ok":true,"loadIds":["P1","O1"],"loadStatuses":{"P1":"PENDING","O1":"OPEN"}}');
 ASSERT public.poc_record_load_interest(h,'P1','+12125550123',false,1)->>'error'='INVALID_INTEREST_REQUEST';
 ASSERT public.poc_record_load_interest(h,'P1','135797',true,1)->>'error'='INVALID_INTEREST_REQUEST';
 ASSERT public.poc_record_load_interest(h,'P1','+12125550123',true,2)->>'error'='CALL_CHANGED';
 ASSERT public.poc_record_load_interest(h,'X1','+12125550123',true,1)->>'error'='LOAD_NOT_IN_CALL';
 ASSERT public.poc_record_load_interest(h,'O1','+12125550123',true,1)->>'error'='LOAD_STATUS_CHANGED';
 ASSERT public.poc_negotiate(h,'quote','P1',1,100000,120000)->>'error'='LOAD_UNAVAILABLE';
 PERFORM public.poc_call_action(h,'save_loads',p_metadata:='{"command":"LOAD_GET","loadId":"O1","revision":1,"ok":true,"loadIds":["O1"],"loadStatuses":{"O1":"OPEN"}}');
 n:=public.poc_negotiate(h,'quote','O1',1,100000,120000); ASSERT n->>'ok'='true';
 -- A previously offered load becomes pending; its old offer must not be accepted.
 PERFORM public.poc_call_action(h,'save_loads',p_metadata:='{"command":"LOAD_GET","loadId":"O1","revision":1,"ok":true,"loadIds":["O1"],"loadStatuses":{"O1":"PENDING"}}');
 ASSERT public.poc_negotiate(h,'accept','O1',p_offer_id:=(n->'negotiation'->>'offer_id')::uuid)->>'error'='LOAD_UNAVAILABLE';
 first:=public.poc_record_load_interest(h,'P1','+12125550123',true,1);
 ASSERT first->>'ok'='true'; ASSERT first->'interest'->>'status'='recorded';
 ASSERT first->'interest'->>'notification_sent'='false'; ASSERT first->'interest'->>'callback_guaranteed'='false';
 r:=public.poc_record_load_interest(h,'P1','+12125550123',true,1);
 ASSERT r->>'replayed'='true'; ASSERT r->'interest'=first->'interest';
 ASSERT public.poc_record_load_interest(h,'P1','+12125550124',true,1)->>'error'='INTEREST_ALREADY_RECORDED';
 ASSERT (SELECT count(*)=1 FROM public.poc_call_events WHERE call_id=cid AND event='load_interest_recorded');
 ASSERT (SELECT booking IS NULL FROM public.poc_calls WHERE id=cid);
 ASSERT public.poc_call_action(h,'authority_begin')->>'error'='INTEREST_ALREADY_RECORDED';
 r:=public.poc_finalize_call(h,'conversation_complete','Pending load interest recorded; no callback promised.');
 ASSERT r->>'ok'='true'; ASSERT r->'session'->'loadInterest'=first->'interest';
 ASSERT r->'session'->>'finalOutcome'='conversation_complete';
 ASSERT public.poc_call_action(h,'status')->'session'->'loadInterest'=first->'interest';
END $$;
ROLLBACK;
