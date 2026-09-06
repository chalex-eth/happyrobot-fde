-- Disposable database only; all fixtures roll back.
BEGIN;
CREATE FUNCTION pg_temp.booking_ready(h text, lid text DEFAULT 'B1') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE cid uuid:=gen_random_uuid(); q jsonb; terms jsonb;
BEGIN
 PERFORM public.poc_start_call(cid,h);
 UPDATE public.poc_calls SET authority_passed=true,authority_revision=1,
  authority_check='{"eligible":true,"outcome":"eligible","mcNumber":"1515"}',
  otp_state='verified',otp_verified_at=now(),available_load_ids=jsonb_build_array(lid),selected_load_id=lid WHERE id=cid;
 q:=public.poc_negotiate(h,'quote',lid,1,100000,120000);
 terms:=jsonb_build_object('LOAD_ID',lid,'STATUS','OPEN','RATE','1000','EQTYPE','FLATBED');
 ASSERT public.poc_book_call(h,'quote',jsonb_build_object('loadId',lid,'offerId',q->'negotiation'->>'offer_id','terms',terms))->>'ok'='true';
 q:=public.poc_negotiate(h,'accept',lid,p_offer_id:=(q->'negotiation'->>'offer_id')::uuid);
 RETURN jsonb_build_object('loadId',lid,'offerId',q->'negotiation'->>'offer_id','attemptId',gen_random_uuid(),
  'terms',terms,'listedCents',100000,'maxCents',120000);
END $$;
DO $$
DECLARE h text:=repeat('1',64); m jsonb; r jsonb; b jsonb; other jsonb; i integer;
BEGIN
 -- Material term refresh rotates identity without resetting counter rounds.
 PERFORM public.poc_start_call(gen_random_uuid(),repeat('9',64));
 UPDATE public.poc_calls SET authority_passed=true,authority_revision=1,
  authority_check='{"eligible":true,"outcome":"eligible","mcNumber":"1515"}',
  otp_state='verified',otp_verified_at=now(),available_load_ids='["B9"]',selected_load_id='B9' WHERE session_hash=repeat('9',64);
 r:=public.poc_negotiate(repeat('9',64),'quote','B9',1,100000,120000);
 other:=jsonb_build_object('loadId','B9','offerId',r->'negotiation'->>'offer_id','terms','{"LOAD_ID":"B9","STATUS":"OPEN","EQTYPE":"FLATBED"}'::jsonb);
 PERFORM public.poc_book_call(repeat('9',64),'quote',other);
 b:=public.poc_book_call(repeat('9',64),'quote',jsonb_set(other,'{terms,EQTYPE}','"REEFER"'));
 ASSERT b->'negotiation'->>'offer_id'<>other->>'offerId';
 ASSERT public.poc_negotiate(repeat('9',64),'accept','B9',p_offer_id:=(other->>'offerId')::uuid)->>'error'='OFFER_CHANGED';
 m:=pg_temp.booking_ready(h);
 UPDATE public.poc_calls SET authority_passed=false WHERE session_hash=h;
 ASSERT public.poc_book_call(h,'claim',m)->>'error'='AUTHORITY_REQUIRED';
 UPDATE public.poc_calls SET authority_passed=true,otp_state='pending' WHERE session_hash=h;
 ASSERT public.poc_book_call(h,'claim',m)->>'error'='OTP_REQUIRED';
 UPDATE public.poc_calls SET otp_state='verified' WHERE session_hash=h;
 ASSERT public.poc_book_call(h,'claim',m||'{"offerId":"00000000-0000-4000-8000-000000000000"}')->>'error'='OFFER_CHANGED';
 ASSERT public.poc_book_call(h,'claim',m||'{"maxCents":110000}')->>'error'='BOOKING_TERMS_CHANGED';
 ASSERT public.poc_book_call(h,'claim',jsonb_set(m,'{terms,EQTYPE}','"REEFER"'))->>'error'='BOOKING_TERMS_CHANGED';
 ASSERT (SELECT booking IS NULL FROM public.poc_calls WHERE session_hash=h);
 r:=public.poc_book_call(h,'claim',m); ASSERT r->>'claimed'='true';
 ASSERT r->>'mcNumber'='1515'; ASSERT (r->>'agreedCents')::int=100000;
 b:=r->'booking'; ASSERT b->>'status'='pending';
 ASSERT public.poc_book_call(h,'claim',m)->>'claimed'='false';
 ASSERT public.poc_book_call(h,'claim',m||'{"loadId":"OTHER"}')->>'error'='BOOKING_ATTEMPT_CHANGED';
 ASSERT public.poc_call_action(h,'authority_begin',p_metadata:='{"mcNumber":"1515"}')->>'error'='BOOKING_ALREADY_ATTEMPTED';
 ASSERT public.poc_negotiate(h,'quote','B1',1,100000,120000)->>'error'='BOOKING_ALREADY_ATTEMPTED';
 ASSERT public.poc_finalize_call(h,'conversation_complete','Pending')->>'error'='BOOKING_IN_PROGRESS';
 -- A second call cannot duplicate the pending booking for the same load.
 other:=pg_temp.booking_ready(repeat('2',64));
 ASSERT public.poc_book_call(repeat('2',64),'claim',other)->>'error'='BOOKING_REVIEW_REQUIRED';
 ASSERT public.poc_book_call(h,'complete',m||'{"result":{"status":"confirmed","reference":"BR1"}}')->>'error'='INVALID_BOOKING_RESULT';
 m:=m||'{"result":{"status":"confirmed","reference":"BR1","timestamp":"20260906120000"}}';
 r:=public.poc_book_call(h,'complete',m); ASSERT r->'booking'->>'status'='confirmed';
 ASSERT r->'booking'->>'handoff_mock'='true';
 ASSERT public.poc_book_call(h,'complete',m)=r;
 r:=public.poc_finalize_call(h,'technical_error','Confirmed booking, simulated handoff.');
 ASSERT r->'session'->>'finalOutcome'='booked'; ASSERT r->'session'->'booking'->>'reference'='BR1';
 ASSERT public.poc_finalize_call(h,'conversation_complete','Confirmed booking, simulated handoff.')=r;
 ASSERT public.poc_book_call(h,'prepare',m)->'booking'->>'status'='confirmed';
 ASSERT (SELECT count(*) FROM public.poc_call_events e JOIN public.poc_calls c ON e.call_id=c.id WHERE c.session_hash=h AND event='booking_attempted')=1;
 ASSERT (SELECT count(*) FROM public.poc_call_events e JOIN public.poc_calls c ON e.call_id=c.id WHERE c.session_hash=h AND event='handoff_mock_recorded')=1;
 -- Explicit rejection and unknown outcome preserve rate agreement and never hand off.
 FOR i IN 3..4 LOOP
  h:=repeat(i::text,64); m:=pg_temp.booking_ready(h,'B'||i);
  PERFORM public.poc_book_call(h,'claim',m);
  m:=m||jsonb_build_object('result',jsonb_build_object('status',CASE i WHEN 3 THEN 'rejected' ELSE 'uncertain' END,'error','TMS_TIMEOUT'));
  r:=public.poc_book_call(h,'complete',m);
  ASSERT r->'booking'->>'handoff_mock'='false';
  r:=public.poc_finalize_call(h,'conversation_complete','Booking not confirmed.');
  ASSERT r->'session'->>'finalOutcome'=CASE i WHEN 3 THEN 'booking_failed' ELSE 'booking_uncertain' END;
  ASSERT (r->'session'->'negotiation'->>'agreed_rate')::numeric=1000;
 END LOOP;
 -- Crash/late completion: old pending appears uncertain, cannot resend,
 -- and can still record its eventual result after finalization/session expiry.
 h:=repeat('5',64);m:=pg_temp.booking_ready(h,'B5');PERFORM public.poc_book_call(h,'claim',m);
 UPDATE public.poc_calls SET booking=jsonb_set(booking,'{attempted_at}',to_jsonb(now()-interval '1 minute')) WHERE session_hash=h;
 ASSERT public.poc_book_call(h,'prepare',m)->'booking'->>'status'='uncertain';
 ASSERT public.poc_finalize_call(h,'technical_error','Call interrupted.')->'session'->>'finalOutcome'='booking_uncertain';
 UPDATE public.poc_calls SET session_expires_at=now()-interval '1 second' WHERE session_hash=h;
 r:=public.poc_book_call(h,'complete',m||'{"result":{"status":"confirmed","reference":"BR5","timestamp":"20260906120000"}}');
 ASSERT r->'booking'->>'status'='confirmed';
 ASSERT (SELECT final_outcome FROM public.poc_calls WHERE session_hash=h)='booked';
 ASSERT (SELECT final_result->'session'->'booking'->>'reference' FROM public.poc_calls WHERE session_hash=h)='BR5';
 ASSERT NOT has_schema_privilege('public','poc_private','USAGE');
 RAISE NOTICE 'PASS: booking gates, terms, claim/replay, cross-call protection, finalization, uncertainty and late completion';
END $$;
ROLLBACK;
