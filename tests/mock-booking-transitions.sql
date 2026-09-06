-- Disposable PostgreSQL only. All fixtures roll back.
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
DECLARE m jsonb; r jsonb; first jsonb; i integer; h text;
BEGIN
 -- The same OPEN load can be simulated across calls, without consuming inventory.
 FOR i IN 1..2 LOOP
  h:=repeat(i::text,64); m:=pg_temp.booking_ready(h,'MOCKLOAD') || '{"simulated":true}';
  r:=public.poc_book_call(h,'claim',m);
  ASSERT r->>'claimed'='true'; ASSERT r->'booking'->>'simulated'='true';
  ASSERT public.poc_book_call(h,'claim',m)->>'claimed'='false';
  ASSERT public.poc_book_call(h,'complete',m||'{"result":{"status":"confirmed","reference":"BR1","timestamp":"20260906120000"}}')->>'error'='BOOKING_MODE_MISMATCH';
  m:=m||jsonb_build_object('result',jsonb_build_object('status','confirmed','reference','MOCK-'||(m->>'attemptId'),'timestamp','20260906120000','simulated',true));
  r:=public.poc_book_call(h,'complete',m); ASSERT r->'booking'->>'status'='confirmed';
  ASSERT r->'booking'->>'simulated'='true'; ASSERT NOT (r->'booking' ? 'tms_timestamp_utc');
  ASSERT public.poc_book_call(h,'complete',m)=r;
  first:=public.poc_finalize_call(h,'conversation_complete','Simulated booking saved; no TMS reservation.');
  ASSERT first->'session'->>'finalOutcome'='booking_simulated';
  ASSERT first->'session'->'booking'->>'simulated'='true';
  ASSERT public.poc_finalize_call(h,'conversation_complete','Simulated booking saved; no TMS reservation.')=first;
  ASSERT (SELECT count(*)=1 FROM public.poc_call_events e JOIN public.poc_calls c ON e.call_id=c.id WHERE c.session_hash=h AND event='booking_attempted');
  ASSERT (SELECT metadata->>'bookingConfirmed'='false' FROM public.poc_call_events e JOIN public.poc_calls c ON e.call_id=c.id WHERE c.session_hash=h AND event='call_finalized');
 END LOOP;
 -- Mock claims do not prevent real claims; real claims still exclude one another.
 h:=repeat('3',64);m:=pg_temp.booking_ready(h,'MOCKLOAD');
 ASSERT public.poc_book_call(h,'claim',m)->>'claimed'='true';
 ASSERT (SELECT booking->>'simulated'='false' FROM public.poc_calls WHERE session_hash=h);
 h:=repeat('4',64);m:=pg_temp.booking_ready(h,'MOCKLOAD');
 ASSERT public.poc_book_call(h,'claim',m)->>'error'='BOOKING_REVIEW_REQUIRED';
 -- Simulation leaves the earlier real pending attempt untouched.
 ASSERT public.poc_book_call(h,'claim',m||'{"simulated":true}')->>'claimed'='true';
 ASSERT (SELECT booking->>'status'='pending' AND booking->>'simulated'='false' FROM public.poc_calls WHERE session_hash=repeat('3',64));
END $$;
ROLLBACK;
