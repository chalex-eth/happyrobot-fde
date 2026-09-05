BEGIN;
DO $$
DECLARE h text:=repeat('f',64); r jsonb; replay jsonb; cid uuid:='33333333-3333-4333-8333-333333333333';
BEGIN
  PERFORM public.poc_start_call(cid,h);
  r:=public.poc_finalize_call(h,'booked','invented booking');
  IF r->>'error'<>'INVALID_FINALIZATION' THEN RAISE EXCEPTION 'Must reject booking outcome'; END IF;
  r:=public.poc_finalize_call(h,'conversation_complete','Caller ended before verification.');
  IF r->>'ok'<>'true' OR r->'session'->>'verified'<>'false' THEN RAISE EXCEPTION 'Unexpected final facts'; END IF;
  replay:=public.poc_finalize_call(h,'conversation_complete','Caller ended before verification.');
  IF replay IS DISTINCT FROM r THEN RAISE EXCEPTION 'Replay must return original snapshot'; END IF;
  IF (SELECT count(*) FROM public.poc_call_events WHERE call_id=cid AND event='call_finalized')<>1 THEN RAISE EXCEPTION 'Duplicate finalization'; END IF;
  IF public.poc_finalize_call(h,'technical_error','Changed')->>'error'<>'CALL_ALREADY_FINALIZED' THEN RAISE EXCEPTION 'Conflicting finalization'; END IF;
  IF public.poc_call_action(h,'authority_begin',p_metadata:='{"mcNumber":"1515"}')->>'error'<>'CALL_FINALIZED' THEN RAISE EXCEPTION 'Closed call mutated'; END IF;
  IF public.poc_call_action(h,'status')->'session'->>'finalizedAt' IS NULL THEN RAISE EXCEPTION 'Missing final status'; END IF;
END $$;
ROLLBACK;
