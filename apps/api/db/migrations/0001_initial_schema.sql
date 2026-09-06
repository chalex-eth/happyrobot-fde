-- Fresh databases only. Existing installations require a separate data migration.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA poc_private;

-- Domain records and structural constraints
CREATE TABLE poc_private.negotiations (
    call_id uuid NOT NULL,
    authority_revision integer NOT NULL,
    load_id text NOT NULL,
    offer_id uuid DEFAULT gen_random_uuid() NOT NULL,
    listed_cents bigint NOT NULL,
    max_cents bigint NOT NULL,
    offered_cents bigint NOT NULL,
    agreed_cents bigint,
    counter_rounds integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'offered'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT negotiations_max_at_least_listed CHECK ((max_cents >= listed_cents)),
    CONSTRAINT negotiations_offered_within_max CHECK (((offered_cents > 0) AND (offered_cents <= max_cents))),
    CONSTRAINT negotiations_agreed_within_max CHECK (((agreed_cents > 0) AND (agreed_cents <= max_cents))),
    CONSTRAINT negotiations_counter_rounds_check CHECK (((counter_rounds >= 0) AND (counter_rounds <= 3))),
    CONSTRAINT negotiations_listed_cents_check CHECK ((listed_cents > 0)),
    CONSTRAINT negotiations_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'offered'::text, 'agreed'::text, 'rejected'::text, 'failed'::text])))
);

CREATE TABLE poc_private.offer_receipts (
    call_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    fingerprint jsonb NOT NULL,
    result jsonb NOT NULL
);

CREATE TABLE poc_private.operator_access (
    key_hash text NOT NULL
);

CREATE TABLE poc_private.otp_receipts (
    call_id uuid NOT NULL,
    operation_id text NOT NULL,
    authority_revision integer NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL
);

CREATE TABLE public.poc_call_events (
    id bigint NOT NULL,
    call_id uuid NOT NULL,
    event text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE public.poc_call_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.poc_call_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.poc_calls (
    id uuid NOT NULL,
    session_hash text NOT NULL,
    authority_check jsonb,
    authority_passed boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    session_expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval) NOT NULL,
    otp_state text DEFAULT 'not_sent'::text NOT NULL,
    challenge_id uuid,
    otp_digest text,
    otp_expires_at timestamp with time zone,
    otp_attempts integer DEFAULT 0 NOT NULL,
    otp_verified_at timestamp with time zone,
    demo_recipient text,
    authority_revision integer DEFAULT 0 NOT NULL,
    available_load_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    selected_load_id text,
    voice_run_id text,
    voice_state text DEFAULT 'idle'::text NOT NULL,
    finalized_at timestamp with time zone,
    final_outcome text,
    final_summary text,
    final_result jsonb,
    revision bigint DEFAULT 0 NOT NULL CHECK (revision >= 0),
    otp_failures integer DEFAULT 0 NOT NULL,
    booking jsonb,
    booking_terms jsonb,
    load_statuses jsonb DEFAULT '{}'::jsonb NOT NULL,
    load_interest jsonb,
    source text DEFAULT 'unknown'::text NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    reported_end_reason text,
    ended_at timestamp with time zone,
    end_evidence text,
    load_snapshots jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT poc_calls_otp_failures_check CHECK (((otp_failures >= 0) AND (otp_failures <= 2))),
    CONSTRAINT poc_calls_otp_state_check CHECK ((otp_state = ANY (ARRAY['not_sent'::text, 'dispatching'::text, 'pending'::text, 'failed'::text, 'expired'::text, 'locked'::text, 'verified'::text]))),
    CONSTRAINT poc_calls_session_hash_check CHECK ((session_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT poc_calls_voice_state_check CHECK ((voice_state = ANY (ARRAY['idle'::text, 'creating'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE public.poc_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    call_id uuid NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    detail text NOT NULL,
    callback_number text,
    source_key text NOT NULL,
    revision uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolution_note text,
    reviewed_at timestamp with time zone,
    CONSTRAINT poc_reviews_status_check CHECK ((status = ANY (ARRAY['open'::text, 'reviewed'::text])))
);

ALTER TABLE ONLY poc_private.negotiations
    ADD CONSTRAINT negotiations_pkey PRIMARY KEY (call_id);

ALTER TABLE ONLY poc_private.offer_receipts
    ADD CONSTRAINT offer_receipts_pkey PRIMARY KEY (call_id, offer_id);

ALTER TABLE ONLY poc_private.operator_access
    ADD CONSTRAINT operator_access_pkey PRIMARY KEY (key_hash);

ALTER TABLE ONLY poc_private.otp_receipts
    ADD CONSTRAINT otp_receipts_pkey PRIMARY KEY (call_id, operation_id);

ALTER TABLE ONLY public.poc_call_events
    ADD CONSTRAINT poc_call_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.poc_calls
    ADD CONSTRAINT poc_calls_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.poc_calls
    ADD CONSTRAINT poc_calls_session_hash_key UNIQUE (session_hash);

ALTER TABLE ONLY public.poc_calls
    ADD CONSTRAINT poc_calls_voice_run_id_key UNIQUE (voice_run_id);

ALTER TABLE ONLY public.poc_reviews
    ADD CONSTRAINT poc_reviews_call_id_reason_key UNIQUE (call_id, reason);

ALTER TABLE ONLY public.poc_reviews
    ADD CONSTRAINT poc_reviews_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX poc_booking_load_claim ON public.poc_calls USING btree (((booking ->> 'load_id'::text))) WHERE (((booking ->> 'status'::text) = ANY (ARRAY['pending'::text, 'confirmed'::text, 'uncertain'::text])) AND (COALESCE((booking ->> 'simulated'::text), 'false'::text) <> 'true'::text));

CREATE INDEX poc_calls_recent ON public.poc_calls USING btree (created_at DESC, id);

CREATE INDEX poc_events_call_time ON public.poc_call_events USING btree (call_id, created_at);

CREATE INDEX poc_events_send_time ON public.poc_call_events USING btree (created_at) WHERE (event = 'otp_requested'::text);

CREATE INDEX poc_reviews_open ON public.poc_reviews USING btree (updated_at DESC) WHERE (status = 'open'::text);

ALTER TABLE ONLY poc_private.negotiations
    ADD CONSTRAINT negotiations_call_id_fkey FOREIGN KEY (call_id) REFERENCES public.poc_calls(id);

ALTER TABLE ONLY poc_private.offer_receipts
    ADD CONSTRAINT offer_receipts_call_id_fkey FOREIGN KEY (call_id) REFERENCES public.poc_calls(id);

ALTER TABLE ONLY poc_private.otp_receipts
    ADD CONSTRAINT otp_receipts_call_id_fkey FOREIGN KEY (call_id) REFERENCES public.poc_calls(id);

ALTER TABLE ONLY public.poc_call_events
    ADD CONSTRAINT poc_call_events_call_id_fkey FOREIGN KEY (call_id) REFERENCES public.poc_calls(id);

ALTER TABLE ONLY public.poc_reviews
    ADD CONSTRAINT poc_reviews_call_id_fkey FOREIGN KEY (call_id) REFERENCES public.poc_calls(id);


-- Transport receipts are distinct from business receipts (OTP and offers).
CREATE TABLE poc_private.operation_receipts (
 call_id uuid NOT NULL REFERENCES public.poc_calls(id), operation_id text NOT NULL,
 phase text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(call_id,operation_id,phase)
);
CREATE TABLE poc_private.backend_access (key_hash text PRIMARY KEY);

-- Backend credential is provisioned separately, never embedded in this migration.
CREATE FUNCTION poc_private.authenticate_backend(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM poc_private.backend_access WHERE key_hash=encode(sha256(convert_to(p_key,'UTF8')),'hex')) THEN
  RAISE EXCEPTION 'BACKEND_AUTH_REQUIRED' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION poc_private.call_snapshot(cid uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('call',to_jsonb(c),'now',statement_timestamp(),
 'negotiation',(SELECT to_jsonb(n) FROM poc_private.negotiations n WHERE call_id=cid),
 'otpReceipts',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM poc_private.otp_receipts r WHERE call_id=cid),'[]'),
 'offerReceipts',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM poc_private.offer_receipts r WHERE call_id=cid),'[]'),
 'events',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.poc_call_events e WHERE call_id=cid),'[]'),
 'reviews',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY created_at,id) FROM public.poc_reviews r WHERE call_id=cid),'[]'))
 FROM public.poc_calls c WHERE id=cid
$$;
CREATE FUNCTION public.poc_read_call(p_key text,p_selector jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cid uuid;
BEGIN
 PERFORM poc_private.authenticate_backend(p_key);

 SELECT id INTO cid FROM public.poc_calls WHERE
 (p_selector ? 'id' AND id=(p_selector->>'id')::uuid) OR
 (p_selector ? 'hash' AND session_hash=p_selector->>'hash') OR
 (p_selector ? 'runId' AND voice_run_id=p_selector->>'runId');
 RETURN poc_private.call_snapshot(cid);
END $$;
CREATE FUNCTION public.poc_read_receipt(p_key text,p_call_id uuid,p_operation_id text,p_phase text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM poc_private.authenticate_backend(p_key);
 RETURN (SELECT to_jsonb(r) FROM poc_private.operation_receipts r WHERE call_id=p_call_id AND operation_id=p_operation_id AND phase=p_phase);
END $$;
CREATE FUNCTION public.poc_query_calls(p_key text,p_operator_key text,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM poc_private.authenticate_backend(p_key);
 IF NOT EXISTS(SELECT 1 FROM poc_private.operator_access WHERE key_hash=encode(sha256(convert_to(p_operator_key,'UTF8')),'hex')) THEN
  RETURN jsonb_build_object('error','OPERATOR_AUTH_REQUIRED');
 END IF;
 RETURN coalesce((SELECT jsonb_agg(poc_private.call_snapshot(id) ORDER BY created_at DESC,id) FROM
 (SELECT id,created_at FROM public.poc_calls ORDER BY created_at DESC,id LIMIT 100 OFFSET greatest(p_offset,0)) c),'[]');
END $$;
CREATE FUNCTION public.poc_insert_call(p_key text,p_call jsonb,p_previous_hash text,p_event jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE;
BEGIN
 PERFORM poc_private.authenticate_backend(p_key);
 c:=jsonb_populate_record(NULL::public.poc_calls,p_call);
 -- A retry of the same insertion cannot invalidate another session twice.
 IF EXISTS(SELECT 1 FROM public.poc_calls WHERE id=c.id AND session_hash=c.session_hash) THEN
  RETURN poc_private.call_snapshot(c.id);
 END IF;
 UPDATE public.poc_calls SET session_expires_at=statement_timestamp(),otp_digest=NULL,revision=revision+1 WHERE session_hash=p_previous_hash;
 INSERT INTO public.poc_calls SELECT c.*;
 INSERT INTO public.poc_call_events(call_id,event,metadata,created_at)
 VALUES(c.id,p_event->>'event',p_event->'metadata',(p_event->>'created_at')::timestamptz);
 RETURN poc_private.call_snapshot(c.id);
END $$;

-- Fixed, allowlisted writes. All business decisions are supplied by the backend.
CREATE FUNCTION public.poc_commit_call(p_key text,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.poc_calls%ROWTYPE; next_call public.poc_calls%ROWTYPE; r poc_private.operation_receipts%ROWTYPE;
 changes jsonb:=p_command->'changes'; item jsonb; constraint_name text;
BEGIN
 PERFORM poc_private.authenticate_backend(p_key);
 SELECT * INTO c FROM public.poc_calls WHERE id=(p_command->>'callId')::uuid FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','SESSION_REQUIRED'); END IF;
 SELECT * INTO r FROM poc_private.operation_receipts WHERE call_id=c.id AND operation_id=p_command->>'operationId' AND phase=p_command->>'phase';
 IF FOUND THEN
  IF r.fingerprint IS DISTINCT FROM p_command->>'fingerprint' THEN RETURN jsonb_build_object('code','OPERATION_CHANGED'); END IF;
  RETURN jsonb_build_object('code','replayed','result',r.result);
 END IF;
 IF c.revision IS DISTINCT FROM (p_command->>'expectedRevision')::bigint THEN RETURN jsonb_build_object('code','conflict'); END IF;
 IF coalesce((p_command#>>'{preconditions,activeSession}')::boolean,false) AND c.session_expires_at<=clock_timestamp() THEN
  RETURN jsonb_build_object('code','SESSION_REQUIRED');
 END IF;
 IF p_command#>>'{preconditions,validUntil}' IS NOT NULL AND (p_command#>>'{preconditions,validUntil}')::timestamptz<=clock_timestamp() THEN
  RETURN jsonb_build_object('code','conflict');
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(changes) k WHERE k NOT IN ('call','negotiation','events','reviews','otpReceipts','offerReceipts')) THEN RAISE EXCEPTION 'INVALID_CHANGES'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(coalesce(changes->'call','{}')) k WHERE k NOT IN ('authority_check','authority_passed','session_expires_at','otp_state','challenge_id','otp_digest','otp_expires_at','otp_attempts','otp_verified_at','demo_recipient','authority_revision','available_load_ids','selected_load_id','voice_run_id','voice_state','finalized_at','final_outcome','final_summary','final_result','otp_failures','booking','booking_terms','load_statuses','load_interest','source','last_activity_at','reported_end_reason','ended_at','end_evidence','load_snapshots')) THEN RAISE EXCEPTION 'INVALID_CALL_FIELDS'; END IF;
 next_call:=jsonb_populate_record(c,coalesce(changes->'call','{}'));
 UPDATE public.poc_calls SET authority_check=next_call.authority_check,
 authority_passed=next_call.authority_passed,
 session_expires_at=next_call.session_expires_at,
 otp_state=next_call.otp_state,
 challenge_id=next_call.challenge_id,
 otp_digest=next_call.otp_digest,
 otp_expires_at=next_call.otp_expires_at,
 otp_attempts=next_call.otp_attempts,
 otp_verified_at=next_call.otp_verified_at,
 demo_recipient=next_call.demo_recipient,
 authority_revision=next_call.authority_revision,
 available_load_ids=next_call.available_load_ids,
 selected_load_id=next_call.selected_load_id,
 voice_run_id=next_call.voice_run_id,
 voice_state=next_call.voice_state,
 finalized_at=next_call.finalized_at,
 final_outcome=next_call.final_outcome,
 final_summary=next_call.final_summary,
 final_result=next_call.final_result,
 otp_failures=next_call.otp_failures,
 booking=next_call.booking,
 booking_terms=next_call.booking_terms,
 load_statuses=next_call.load_statuses,
 load_interest=next_call.load_interest,
 source=next_call.source,
 last_activity_at=next_call.last_activity_at,
 reported_end_reason=next_call.reported_end_reason,
 ended_at=next_call.ended_at,
 end_evidence=next_call.end_evidence,
 load_snapshots=next_call.load_snapshots,revision=c.revision+1 WHERE id=c.id;
 IF changes ? 'negotiation' THEN
  IF changes->'negotiation'->>'call_id' IS DISTINCT FROM c.id::text THEN RAISE EXCEPTION 'INVALID_CALL_ID'; END IF;
  INSERT INTO poc_private.negotiations SELECT (jsonb_populate_record(NULL::poc_private.negotiations,changes->'negotiation')).*
  ON CONFLICT(call_id) DO UPDATE SET authority_revision=EXCLUDED.authority_revision,load_id=EXCLUDED.load_id,offer_id=EXCLUDED.offer_id,listed_cents=EXCLUDED.listed_cents,max_cents=EXCLUDED.max_cents,offered_cents=EXCLUDED.offered_cents,agreed_cents=EXCLUDED.agreed_cents,counter_rounds=EXCLUDED.counter_rounds,status=EXCLUDED.status,expires_at=EXCLUDED.expires_at;
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(coalesce(changes->'events','[]')) LOOP
  INSERT INTO public.poc_call_events(call_id,event,metadata,created_at) VALUES(c.id,item->>'event',item->'metadata',(item->>'created_at')::timestamptz);
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(coalesce(changes->'reviews','[]')) LOOP
  IF item->>'call_id' IS DISTINCT FROM c.id::text THEN RAISE EXCEPTION 'INVALID_CALL_ID'; END IF;
  INSERT INTO public.poc_reviews SELECT (jsonb_populate_record(NULL::public.poc_reviews,item)).*
  ON CONFLICT(call_id,reason) DO UPDATE SET status=EXCLUDED.status,detail=EXCLUDED.detail,callback_number=EXCLUDED.callback_number,source_key=EXCLUDED.source_key,revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at,resolution_note=EXCLUDED.resolution_note,reviewed_at=EXCLUDED.reviewed_at;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(coalesce(changes->'otpReceipts','[]')) LOOP
  IF item->>'call_id' IS DISTINCT FROM c.id::text THEN RAISE EXCEPTION 'INVALID_CALL_ID'; END IF;
  INSERT INTO poc_private.otp_receipts SELECT (jsonb_populate_record(NULL::poc_private.otp_receipts,item)).*;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(coalesce(changes->'offerReceipts','[]')) LOOP
  IF item->>'call_id' IS DISTINCT FROM c.id::text THEN RAISE EXCEPTION 'INVALID_CALL_ID'; END IF;
  INSERT INTO poc_private.offer_receipts SELECT (jsonb_populate_record(NULL::poc_private.offer_receipts,item)).*;
 END LOOP;
 INSERT INTO poc_private.operation_receipts VALUES(c.id,p_command->>'operationId',p_command->>'phase',p_command->>'fingerprint',p_command->'result');
 RETURN jsonb_build_object('code','committed','result',p_command->'result');
EXCEPTION WHEN unique_violation THEN
 GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;
 IF constraint_name='poc_booking_load_claim' THEN RETURN jsonb_build_object('code','BOOKING_REVIEW_REQUIRED'); END IF;
 RAISE;
END $$;

-- Gateway users receive no table access. RPCs require the backend credential.
REVOKE ALL ON SCHEMA poc_private FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA poc_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA poc_private FROM PUBLIC;
REVOKE ALL ON public.poc_calls,public.poc_call_events,public.poc_reviews FROM PUBLIC;
NOTIFY pgrst,'reload schema';
COMMIT;
