-- DESTRUCTIVE: deletes all carrier-sales application data, including operator access.
-- Stop every application backend first. Run this entire file once in Twin SQL console.
-- Then apply migrations/0001_initial_schema.sql before restarting the backend.
-- Other public tables and Twin system schemas are retained.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- Remove the legacy entry points; do not leave old writers callable.
DROP FUNCTION IF EXISTS
  public.poc_start_call(p_id uuid, p_session_hash text, p_previous_hash text),
  public.poc_create_call(p_id uuid, p_session_hash text, p_check jsonb, p_previous_hash text),
  public.poc_resolve_voice(p_run_id text),
  public.poc_track_call(p_session_hash text, p_action text, p_metadata jsonb),
  public.poc_book_call(p_session_hash text, p_action text, p_metadata jsonb),
  public.poc_call_action(p_session_hash text, p_action text, p_challenge uuid, p_digest text, p_recipient text, p_metadata jsonb, p_matches boolean),
  public.poc_negotiate(p_session_hash text, p_action text, p_load_id text, p_revision integer, p_listed_cents bigint, p_max_cents bigint, p_offer_id uuid, p_amount_cents bigint),
  public.poc_record_load_interest(p_session_hash text, p_load_id text, p_callback_number text, p_consent boolean, p_revision integer),
  public.poc_finalize_call(p_session_hash text, p_outcome text, p_summary text, p_review jsonb),
  public.poc_operator(p_key text, p_action text, p_metadata jsonb);

-- This schema belongs exclusively to carrier-sales. Its tables and helper
-- functions are obsolete. CASCADE also removes the old review trigger.
DROP SCHEMA IF EXISTS poc_private CASCADE;
DROP TABLE IF EXISTS public.poc_reviews, public.poc_call_events, public.poc_calls;
COMMIT;
