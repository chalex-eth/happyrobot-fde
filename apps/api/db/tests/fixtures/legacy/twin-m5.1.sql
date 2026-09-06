-- M5 follow-up: failed provider session creation also needs operator review.
BEGIN;
CREATE OR REPLACE FUNCTION poc_private.capture_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.voice_state IS DISTINCT FROM OLD.voice_state AND NEW.voice_state='failed' THEN
  PERFORM poc_private.raise_review(NEW.id,'technical_error','Voice session could not be started.','voice-start-failed');
 END IF;
 IF NEW.authority_check IS DISTINCT FROM OLD.authority_check AND NEW.authority_check->>'outcome'='unverified' THEN
  PERFORM poc_private.raise_review(NEW.id,'technical_error','Carrier authority lookup could not be completed.',NEW.authority_check::text);
 END IF;
 IF NEW.load_interest IS DISTINCT FROM OLD.load_interest AND NEW.load_interest IS NOT NULL THEN
  PERFORM poc_private.raise_review(NEW.id,'callback_requested','Callback requested about pending load '||(NEW.load_interest->>'load_id'),NEW.load_interest->>'reference',NEW.load_interest->>'callback_number');
 END IF;
 IF NEW.booking IS DISTINCT FROM OLD.booking AND NEW.booking->>'status' IN ('uncertain','rejected') THEN
  PERFORM poc_private.raise_review(NEW.id,CASE NEW.booking->>'status' WHEN 'uncertain' THEN 'booking_uncertain' ELSE 'booking_failed' END,
   coalesce(NEW.booking->>'error','Booking needs review'),NEW.booking->>'attempt_id');
 END IF;
 IF NEW.final_outcome IS DISTINCT FROM OLD.final_outcome AND NEW.final_outcome='technical_error' THEN
  PERFORM poc_private.raise_review(NEW.id,'technical_error','Call ended with a technical error.','finalization');
 END IF;
 RETURN NEW;
END $$;
INSERT INTO public.poc_reviews(call_id,reason,detail,source_key)
SELECT id,'technical_error','Voice session could not be started.','voice-start-failed'
FROM public.poc_calls WHERE voice_state='failed'
ON CONFLICT(call_id,reason) DO NOTHING;
COMMIT;
