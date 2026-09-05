-- Run in disposable PostgreSQL after the complete migration chain, including m3.6.
BEGIN;
CREATE FUNCTION pg_temp.otp_ready(h text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE cid uuid:=gen_random_uuid();
BEGIN
 PERFORM public.poc_start_call(cid,h);
 PERFORM public.poc_call_action(h,'authority_begin',p_metadata:='{"mcNumber":"1515"}');
 PERFORM public.poc_call_action(h,'authority_complete',p_metadata:='{"revision":1,"check":{"eligible":true,"outcome":"eligible","mcNumber":"1515"}}');
 RETURN cid;
END $$;
DO $$
DECLARE h text; cid uuid; ch uuid; other uuid:=gen_random_uuid(); r jsonb; i integer;
BEGIN
 -- Every agreed sequence: zero failures, verification retry, generation retry,
 -- mixed terminal failure, two wrong codes, and two delivery failures.
 FOR i IN 1..6 LOOP
  h:=repeat(i::text,64);cid:=pg_temp.otp_ready(h);ch:=gen_random_uuid();
  ASSERT public.poc_call_action(h,'authorize_load')->>'error'='OTP_REQUIRED';
  r:=public.poc_call_action(h,'issue',ch,repeat('a',64),'test');
  ASSERT r->'session'->>'otpFailuresRemaining'='2';
  ASSERT NOT (r->'session' ? 'otpExpiresAt') AND NOT (r->'session' ? 'verifiedUntil');
  ASSERT public.poc_call_action(h,'verify',ch,p_matches:=true)->>'error'='OTP_NOT_READY';
  IF i IN (3,4,6) THEN
   r:=public.poc_call_action(h,'failed',ch,p_metadata:='{"operationId":"generation-1"}');
   ASSERT r->>'error'='OTP_DELIVERY_FAILED';
   ASSERT public.poc_call_action(h,'failed',ch,p_metadata:='{"operationId":"generation-1"}')->'session'->>'otpFailuresRemaining'='1';
   ch:=gen_random_uuid();PERFORM public.poc_call_action(h,'issue',ch,repeat('a',64),'test');
  END IF;
  IF i=6 THEN
   r:=public.poc_call_action(h,'failed',ch,p_metadata:='{"operationId":"generation-2"}');
  ELSE
   PERFORM public.poc_call_action(h,'sent',ch);
   -- Pending requests reuse the same challenge; no recipient cooldown or send limit.
   ASSERT public.poc_call_action(h,'issue',other,repeat('b',64),'test')->'session'->>'challengeId'=ch::text;
   ASSERT public.poc_call_action(h,'verify',other,p_matches:=true)->>'error'='OTP_CHALLENGE_CHANGED';
   IF i IN (2,5) THEN
    r:=public.poc_call_action(h,'verify',ch,p_matches:=false,p_metadata:='{"operationId":"wrong-1"}');
    ASSERT r->>'error'='OTP_INVALID';
    ASSERT public.poc_call_action(h,'verify',ch,p_matches:=false,p_metadata:='{"operationId":"wrong-1"}')->'session'->>'otpFailuresRemaining'='1';
   END IF;
   -- The legacy timestamp cannot expire either a code or its verification.
   UPDATE public.poc_calls SET otp_expires_at=now()-interval '20 minutes' WHERE id=cid;
   r:=public.poc_call_action(h,'verify',ch,p_matches:=(i<=3),p_metadata:='{"operationId":"answer"}');
  END IF;
  IF i<=3 THEN
   ASSERT r->'session'->>'verified'='true';
   ASSERT public.poc_call_action(h,'verify',ch,p_matches:=true,p_metadata:='{"operationId":"answer"}')->>'ok'='true';
   ASSERT public.poc_call_action(h,'verify',ch,p_matches:=true)->>'error'='OTP_ALREADY_USED';
   UPDATE public.poc_calls SET otp_verified_at=now()-interval '20 minutes' WHERE id=cid;
   ASSERT public.poc_call_action(h,'authorize_load')->>'ok'='true';
   ASSERT public.poc_call_action(h,'otp_failure',p_metadata:='{"operationId":"late-fault"}')->>'error'='ALREADY_VERIFIED';
   ASSERT public.poc_call_action(h,'status')->'session'->>'verified'='true';
  ELSE
   ASSERT r->>'error'='OTP_FAILED';
   ASSERT r->'session'->>'otpFailuresRemaining'='0';
   ASSERT r->'session'->>'otpRetryAllowed'='false';
   ASSERT (SELECT otp_digest IS NULL FROM public.poc_calls WHERE id=cid);
   ASSERT public.poc_call_action(h,'issue',other,repeat('b',64),'test')->>'error'='OTP_FAILED';
   ASSERT public.poc_call_action(h,'verify',ch,p_matches:=true)->>'error'='OTP_FAILED';
   ASSERT public.poc_call_action(h,'authorize_load')->>'error'='OTP_REQUIRED';
   PERFORM public.poc_call_action(h,'authority_begin',p_metadata:='{"mcNumber":"1515"}');
   PERFORM public.poc_call_action(h,'authority_complete',p_metadata:='{"revision":2,"check":{"eligible":true,"outcome":"eligible","mcNumber":"1515"}}');
   ASSERT public.poc_call_action(h,'issue',other,repeat('b',64),'test')->>'error'='OTP_FAILED';
  END IF;
 END LOOP;
 -- A carrier correction invalidates the old challenge but keeps the spent retry.
 h:=repeat('7',64);cid:=pg_temp.otp_ready(h);ch:=gen_random_uuid();
 PERFORM public.poc_call_action(h,'issue',ch,repeat('a',64),'test');PERFORM public.poc_call_action(h,'sent',ch);
 PERFORM public.poc_call_action(h,'verify',ch,p_metadata:='{"operationId":"old-answer"}');
 PERFORM public.poc_call_action(h,'authority_begin',p_metadata:='{"mcNumber":"1515"}');
 ASSERT public.poc_call_action(h,'status')->'session'->>'otpFailuresRemaining'='1';
 ASSERT public.poc_call_action(h,'verify',ch,p_metadata:='{"operationId":"old-answer"}')->>'error'='CALL_CHANGED';
 -- Known service failures are counted once and share the same budget.
 h:=repeat('8',64);cid:=pg_temp.otp_ready(h);
 ASSERT public.poc_call_action(h,'otp_failure',p_metadata:='{"operationId":"service-1"}')->>'error'='OTP_SERVICE_FAILED';
 ASSERT public.poc_call_action(h,'otp_failure',p_metadata:='{"operationId":"service-1"}')->'session'->>'otpFailuresRemaining'='1';
 ASSERT public.poc_call_action(h,'otp_failure',p_metadata:='{"operationId":"service-2"}')->>'error'='OTP_FAILED';
 ASSERT public.poc_call_action(h,'otp_result',p_metadata:='{"operationId":"missing"}')->>'error'='OTP_RESULT_UNCERTAIN';
 ASSERT public.poc_call_action(h,'otp_result',p_metadata:='{"operationId":"service-2"}')->>'replayed'='true';
 ASSERT public.poc_call_action(h,'otp_result',p_metadata:='{"operationId":"service-2","fingerprint":"changed"}')->>'error'='OTP_OPERATION_CHANGED';
 ASSERT public.poc_call_action(repeat('f',64),'status')->>'error'='SESSION_REQUIRED';
 ASSERT NOT has_schema_privilege('public','poc_private','USAGE');
 RAISE NOTICE 'PASS: all OTP sequences, shared budget, receipts, carrier reset guard, no expiry, confidentiality';
END $$;
ROLLBACK;
