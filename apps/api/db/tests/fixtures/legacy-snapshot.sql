-- Legacy parity oracle only. Never applied to the candidate.
CREATE FUNCTION poc_private.call_snapshot(cid uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('call',to_jsonb(c)||'{"revision":0}'::jsonb,'now',statement_timestamp(),
 'negotiation',(SELECT to_jsonb(n) FROM poc_private.negotiations n WHERE call_id=cid),
 'otpReceipts',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM poc_private.otp_receipts r WHERE call_id=cid),'[]'),
 'offerReceipts',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM poc_private.offer_receipts r WHERE call_id=cid),'[]'),
 'events',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.poc_call_events e WHERE call_id=cid),'[]'),
 'reviews',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY created_at,id) FROM public.poc_reviews r WHERE call_id=cid),'[]'))
 FROM public.poc_calls c WHERE id=cid
$$;
