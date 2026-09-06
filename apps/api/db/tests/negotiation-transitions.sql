-- Run only in a disposable database. All synthetic fixtures roll back.
BEGIN;
CREATE FUNCTION pg_temp.ready(h text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE cid uuid:=gen_random_uuid();
BEGIN
 PERFORM public.poc_start_call(cid,h);
 UPDATE public.poc_calls SET authority_passed=true,authority_revision=1,
   authority_check='{"eligible":true,"outcome":"eligible","mcNumber":"1515"}',
   otp_state='verified',otp_verified_at=now(),available_load_ids='["L1","L2"]',selected_load_id='L1' WHERE id=cid;
 RETURN cid;
END $$;
DO $$
DECLARE h text:=repeat('a',64); cid uuid; r jsonb; q jsonb; replay jsonb; token uuid; oldtoken uuid; i integer;
BEGIN
 cid:=pg_temp.ready(h);
 UPDATE public.poc_calls SET authority_passed=false WHERE id=cid;
 ASSERT public.poc_negotiate(h,'quote','L1',1,100000,120000)->>'error'='AUTHORITY_REQUIRED';
 UPDATE public.poc_calls SET authority_passed=true,otp_state='pending' WHERE id=cid;
 ASSERT public.poc_negotiate(h,'quote','L1',1,100000,120000)->>'error'='OTP_REQUIRED';
 UPDATE public.poc_calls SET otp_state='verified',otp_verified_at=now()-interval '6 minutes' WHERE id=cid;
 ASSERT public.poc_negotiate(h,'quote','L1',1,100000,120000)->>'ok'='true';
 UPDATE public.poc_calls SET otp_verified_at=now() WHERE id=cid;
 ASSERT public.poc_negotiate(h,'quote','L2',1,100000,120000)->>'error'='LOAD_NOT_SELECTED';
 ASSERT public.poc_negotiate(h,'quote','L1',0,100000,120000)->>'error'='CALL_CHANGED';
 ASSERT public.poc_negotiate(h,'quote','L1',1,100000,99999)->>'error'='TMS_PRICING_UNAVAILABLE';
 q:=public.poc_negotiate(h,'quote','L1',1,100000,120000);token:=(q->'negotiation'->>'offer_id')::uuid;
 ASSERT public.poc_negotiate(h,'quote','L1',1,100000,120000)=q,'Repeated detail changed offer';
 ASSERT (SELECT count(*) FROM public.poc_call_events WHERE call_id=cid AND event='load_offer')=1;
 ASSERT q->'negotiation'->>'offered_rate'='1000.0000000000000000';
 ASSERT q::text NOT LIKE '%max_%' AND q::text NOT LIKE '%1200%','Ceiling exposed';
 ASSERT public.poc_negotiate(repeat('b',64),'accept','L1',p_offer_id:=token)->>'error'='SESSION_REQUIRED';
 ASSERT public.poc_negotiate(h,'counter','L1',p_offer_id:=token)->>'error'='INVALID_OFFER';
 ASSERT public.poc_negotiate(h,'accept','L1',p_offer_id:=token,p_amount_cents:=100000)->>'error'='INVALID_OFFER';
 r:=public.poc_negotiate(h,'counter','L1',p_offer_id:=token,p_amount_cents:=150000);
 ASSERT r->'negotiation'->>'status'='offered';ASSERT (r->'negotiation'->>'offered_rate')::numeric=1020;
 ASSERT (r->'negotiation'->>'counter_rounds')::int=1;
 ASSERT public.poc_negotiate(h,'counter','L1',p_offer_id:=token,p_amount_cents:=150000)=r,'Replay changed';
 ASSERT public.poc_negotiate(h,'counter','L1',p_offer_id:=token,p_amount_cents:=160000)->>'error'='OFFER_ALREADY_ANSWERED';
 ASSERT (SELECT counter_rounds FROM poc_private.negotiations WHERE call_id=cid)=1;
 -- Change load: preserve global round budget.
 UPDATE public.poc_calls SET selected_load_id='L2' WHERE id=cid;
 q:=public.poc_negotiate(h,'quote','L2',1,200000,240000);token:=(q->'negotiation'->>'offer_id')::uuid;
 r:=public.poc_negotiate(h,'counter','L2',p_offer_id:=token,p_amount_cents:=300000);
 ASSERT (r->'negotiation'->>'counter_rounds')::int=2;
 -- Rechecking the carrier must also preserve budget and invalidate prior offer.
 oldtoken:=(r->'negotiation'->>'offer_id')::uuid;
 PERFORM public.poc_call_action(h,'authority_begin',p_metadata:='{"mcNumber":"1515"}');
 UPDATE public.poc_calls SET authority_passed=true,otp_state='verified',otp_verified_at=now(),available_load_ids='["L1","L2"]',selected_load_id='L1' WHERE id=cid;
 ASSERT public.poc_negotiate(h,'accept','L1',p_offer_id:=oldtoken)->>'error'='OFFER_CHANGED';
 q:=public.poc_negotiate(h,'quote','L1',2,100000,120000);token:=(q->'negotiation'->>'offer_id')::uuid;
 r:=public.poc_negotiate(h,'counter','L1',p_offer_id:=token,p_amount_cents:=150000);
 ASSERT r->'negotiation'->>'status'='failed';ASSERT (r->'negotiation'->>'counter_rounds')::int=3;
 ASSERT public.poc_negotiate(h,'counter','L1',p_offer_id:=token,p_amount_cents:=150000)=r;
 ASSERT (SELECT count(*) FROM public.poc_call_events WHERE call_id=cid AND event='negotiation_failed')=1;
 ASSERT public.poc_call_action(h,'authorize_load',p_metadata:='{"command":"LOAD_QUERY"}')->>'error'='NEGOTIATION_FAILED';
 ASSERT public.poc_negotiate(h,'quote','L1',2,100000,120000)->>'error'='NEGOTIATION_FAILED';
 r:=public.poc_finalize_call(h,'conversation_complete','No rate agreement.');
 ASSERT r->'session'->>'finalOutcome'='failed_negotiation';
 ASSERT public.poc_finalize_call(h,'caller_declined','No rate agreement.')=r;
 ASSERT public.poc_negotiate(h,'accept','L1',p_offer_id:=token)->>'error'='CALL_FINALIZED';

 -- Accept advertised rate without spending a round; agreement is not a booking.
 h:=repeat('b',64);cid:=pg_temp.ready(h);q:=public.poc_negotiate(h,'quote','L1',1,100000,120000);token:=(q->'negotiation'->>'offer_id')::uuid;
 r:=public.poc_negotiate(h,'accept','L1',p_offer_id:=token);
 ASSERT r->'negotiation'->>'status'='agreed';ASSERT (r->'negotiation'->>'agreed_rate')::numeric=1000;
 ASSERT (r->'negotiation'->>'counter_rounds')::int=0;ASSERT r->'negotiation'->>'booking_confirmed'='false';
 ASSERT public.poc_negotiate(h,'accept','L1',p_offer_id:=token)=r;
 ASSERT public.poc_call_action(h,'authorize_load',p_metadata:='{"command":"LOAD_QUERY"}')->>'error'='NEGOTIATION_COMPLETE';
 ASSERT public.poc_finalize_call(h,'conversation_complete','Rate agreed only.')->'session'->>'finalOutcome'='rate_agreed';

 -- A requested rate at the ceiling may be accepted, never a cent above it.
 h:=repeat('c',64);cid:=pg_temp.ready(h);q:=public.poc_negotiate(h,'quote','L1',1,100000,120000);token:=(q->'negotiation'->>'offer_id')::uuid;
 r:=public.poc_negotiate(h,'counter','L1',p_offer_id:=token,p_amount_cents:=120000);
 ASSERT r->'negotiation'->>'status'='agreed';ASSERT (r->'negotiation'->>'agreed_rate')::numeric=1200;
 ASSERT (r->'negotiation'->>'counter_rounds')::int=1;

 -- A narrow private margin must hold the public offer, not quote the ceiling.
 h:=repeat('d',64);cid:=pg_temp.ready(h);q:=public.poc_negotiate(h,'quote','L1',1,100000,101000);token:=(q->'negotiation'->>'offer_id')::uuid;
 r:=public.poc_negotiate(h,'counter','L1',p_offer_id:=token,p_amount_cents:=101001);
 ASSERT r->'negotiation'->>'status'='offered';ASSERT (r->'negotiation'->>'offered_rate')::numeric=1000;
 -- Expired offer cannot accept; fresh detail rotates token but preserves rounds.
 token:=(r->'negotiation'->>'offer_id')::uuid;UPDATE poc_private.negotiations SET expires_at=now()-interval '1 second' WHERE call_id=cid;
 ASSERT public.poc_negotiate(h,'accept','L1',p_offer_id:=token)->>'error'='OFFER_EXPIRED';
 q:=public.poc_negotiate(h,'quote','L1',1,100000,101000);ASSERT q->'negotiation'->>'offer_id'<>token::text;
 ASSERT (q->'negotiation'->>'counter_rounds')::int=1;
 ASSERT public.poc_negotiate(h,'accept','L1',p_offer_id:=token)->>'error'='OFFER_CHANGED';
 token:=(q->'negotiation'->>'offer_id')::uuid;r:=public.poc_negotiate(h,'reject','L1',p_offer_id:=token);
 ASSERT r->'negotiation'->>'status'='rejected';ASSERT (r->'negotiation'->>'counter_rounds')::int=1;
 ASSERT public.poc_negotiate(h,'quote','L1',1,100000,101000)->'negotiation'->>'status'='rejected';
 ASSERT NOT has_schema_privilege('public','poc_private','USAGE');
 RAISE NOTICE 'PASS: authority/OTP, private ceiling, advertised acceptance, counter ceiling, three rounds across loads and rechecks, replay/conflict, expiry, rejection, derived outcomes';
END $$;
ROLLBACK;
