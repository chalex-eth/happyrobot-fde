-- Real PostgreSQL transitions, isolated and rolled back after assertions.
BEGIN;
DO $$
DECLARE
  a text := repeat('a',64); b text := repeat('b',64);
  aid uuid := '00000000-0000-4000-8000-000000000031';
  bid uuid := '00000000-0000-4000-8000-000000000032';
  ch uuid := '00000000-0000-4000-8000-000000000033';
  r jsonb; rev integer;
  evidence jsonb := '{"mcNumber":"1515","eligible":true,"outcome":"eligible","reason":"ACTIVE_CARRIER_AUTHORITY"}';
BEGIN
  r := public.poc_start_call(aid,a);
  ASSERT r->'session'->'check'='null'::jsonb AND r->'session'->>'verified'='false', 'Pending call must not grant access';
  PERFORM public.poc_start_call(bid,b);
  ASSERT public.poc_call_action(a,'issue',ch,repeat('c',64),'test')->>'error'='AUTHORITY_REQUIRED';
  r := public.poc_call_action(a,'authority_begin',p_metadata:='{"mcNumber":"1515"}');
  rev := (r->'session'->>'authorityRevision')::integer;
  r := public.poc_call_action(a,'authority_complete',p_metadata:=jsonb_build_object('revision',rev,'check',evidence));
  ASSERT r->'session'->>'callId'=aid::text, 'Lookup must keep the pending call ID';
  PERFORM public.poc_call_action(a,'issue',ch,repeat('c',64),'call-a');
  PERFORM public.poc_call_action(a,'sent',ch);
  -- Same eligible MC in call B does not transfer A's challenge or identity.
  r := public.poc_call_action(b,'authority_begin',p_metadata:='{"mcNumber":"1515"}');
  PERFORM public.poc_call_action(b,'authority_complete',p_metadata:=jsonb_build_object('revision',1,'check',evidence));
  ASSERT public.poc_call_action(b,'verify',ch,p_matches:=true)->>'error'='OTP_CHALLENGE_CHANGED';
  PERFORM public.poc_call_action(a,'verify',ch,p_matches:=true);
  PERFORM public.poc_call_action(a,'save_loads',p_metadata:=jsonb_build_object('command','LOAD_QUERY','ok',true,'revision',rev,'loadIds',jsonb_build_array('LD00001')));
  ASSERT public.poc_call_action(a,'authorize_load',p_metadata:='{"command":"LOAD_GET","loadId":"LD00002"}')->>'error'='LOAD_NOT_IN_CALL';
  ASSERT public.poc_call_action(a,'authorize_load',p_metadata:='{"command":"LOAD_GET","loadId":"LD00001"}')->>'ok'='true';
  -- Independently verify B; it still cannot use A's search result.
  PERFORM public.poc_call_action(b,'issue',ch,repeat('d',64),'call-b');
  PERFORM public.poc_call_action(b,'sent',ch);
  PERFORM public.poc_call_action(b,'verify',ch,p_matches:=true);
  ASSERT public.poc_call_action(b,'authorize_load',p_metadata:='{"command":"LOAD_GET","loadId":"LD00001"}')->>'error'='LOAD_NOT_IN_CALL';
  PERFORM public.poc_call_action(a,'save_loads',p_metadata:=jsonb_build_object('command','LOAD_GET','loadId','LD00001','ok',true,'revision',rev));
  ASSERT public.poc_call_action(a,'status')->'session'->>'selectedLoadId'='LD00001';
  -- Same-MC recheck preserves identity but requires fresh verification.
  r := public.poc_call_action(a,'authority_begin',p_metadata:='{"mcNumber":"1515"}');
  ASSERT r->'session'->>'callId'=aid::text AND r->'session'->>'verified'='false';
  ASSERT r->'session'->'availableLoadIds'='[]'::jsonb AND r->'session'->'selectedLoadId'='null'::jsonb;
  ASSERT public.poc_call_action(a,'authority_complete',p_metadata:=jsonb_build_object('revision',rev,'check',evidence))->>'error'='CALL_CHANGED', 'Late lookup must not restore old authority';
  PERFORM public.poc_call_action(a,'authority_begin',p_metadata:='{"mcNumber":"133654"}');
  ASSERT public.poc_call_action(a,'verify',ch,p_matches:=true)->>'error'='AUTHORITY_REQUIRED';
  ASSERT public.poc_call_action(a,'save_loads',p_metadata:=jsonb_build_object('command','LOAD_QUERY','ok',true,'revision',rev,'loadIds',jsonb_build_array('LD00001')))->>'error'='AUTHORITY_REQUIRED', 'In-flight TCP result cannot reopen access';
  -- Reverify new carrier; previous revision still cannot commit a load result.
  PERFORM public.poc_call_action(a,'authority_complete',p_metadata:=jsonb_build_object('revision',3,'check',jsonb_set(evidence,'{mcNumber}','"133654"')));
  UPDATE public.poc_calls SET otp_state='verified',otp_verified_at=now() WHERE id=aid;
  ASSERT public.poc_call_action(a,'save_loads',p_metadata:=jsonb_build_object('command','LOAD_QUERY','ok',true,'revision',rev,'loadIds',jsonb_build_array('LD00001')))->>'error'='CALL_CHANGED';
  UPDATE public.poc_calls SET otp_verified_at=now()-interval '6 minutes' WHERE id=aid;
  ASSERT public.poc_call_action(a,'save_loads',p_metadata:='{"command":"LOAD_QUERY","ok":true,"revision":3,"loadIds":[]}')->>'ok'='true';
  ASSERT public.poc_resolve_voice(aid::text)->>'error'='VOICE_BINDING_REQUIRED';
  ASSERT public.poc_call_action(a,'voice_reserve')->>'ok'='true';
  ASSERT public.poc_call_action(a,'voice_reserve')->>'error'='VOICE_ALREADY_STARTED';
  ASSERT public.poc_resolve_voice(aid::text)->>'error'='VOICE_BINDING_REQUIRED';
  PERFORM public.poc_call_action(a,'voice_bind',p_metadata:=jsonb_build_object('runId',aid));
  ASSERT public.poc_resolve_voice(aid::text)->>'sessionHash'=a;
  PERFORM public.poc_call_action(b,'voice_reserve');
  BEGIN
    PERFORM public.poc_call_action(b,'voice_bind',p_metadata:=jsonb_build_object('runId',aid));
    RAISE EXCEPTION 'Duplicate voice binding accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  ASSERT public.poc_call_action(a,'status')->'session'->>'callId'=aid::text;
  PERFORM public.poc_start_call('00000000-0000-4000-8000-000000000034',repeat('e',64),a);
  ASSERT public.poc_resolve_voice(aid::text)->>'error'='VOICE_BINDING_REQUIRED';
  ASSERT public.poc_call_action(a,'status')->>'error'='SESSION_REQUIRED', 'Explicit new call expires old browser/voice context';
END;
$$;
ROLLBACK;
