-- Generated from the Drizzle schema. Fresh databases only.
-- Schemas, domain tables, constraints, indexes, and permissions; no application functions.
BEGIN;
CREATE SCHEMA "poc_private";

--> statement-breakpoint
CREATE TABLE "poc_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_hash" text NOT NULL,
	"authority_check" jsonb,
	"authority_passed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_expires_at" timestamp with time zone DEFAULT now() + interval '1 hour' NOT NULL,
	"otp_state" text DEFAULT 'not_sent' NOT NULL,
	"challenge_id" uuid,
	"otp_digest" text,
	"otp_expires_at" timestamp with time zone,
	"otp_attempts" integer DEFAULT 0 NOT NULL,
	"otp_verified_at" timestamp with time zone,
	"demo_recipient" text,
	"authority_revision" integer DEFAULT 0 NOT NULL,
	"available_load_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_load_id" text,
	"voice_run_id" text,
	"voice_state" text DEFAULT 'idle' NOT NULL,
	"finalized_at" timestamp with time zone,
	"final_outcome" text,
	"final_summary" text,
	"final_result" jsonb,
	"revision" bigint DEFAULT 0 NOT NULL,
	"otp_failures" integer DEFAULT 0 NOT NULL,
	"booking" jsonb,
	"booking_terms" jsonb,
	"load_statuses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"load_interest" jsonb,
	"source" text DEFAULT 'unknown' NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_end_reason" text,
	"ended_at" timestamp with time zone,
	"end_evidence" text,
	"load_snapshots" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "poc_calls_session_hash_unique" UNIQUE("session_hash"),
	CONSTRAINT "poc_calls_voice_run_id_unique" UNIQUE("voice_run_id"),
	CONSTRAINT "poc_calls_revision_check" CHECK ("poc_calls"."revision" >= 0),
	CONSTRAINT "poc_calls_otp_failures_check" CHECK ("poc_calls"."otp_failures" between 0 and 2),
	CONSTRAINT "poc_calls_session_hash_check" CHECK ("poc_calls"."session_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "poc_calls_otp_state_check" CHECK ("poc_calls"."otp_state" in ('not_sent','dispatching','pending','failed','expired','locked','verified')),
	CONSTRAINT "poc_calls_voice_state_check" CHECK ("poc_calls"."voice_state" in ('idle','creating','ready','failed'))
);

--> statement-breakpoint
CREATE TABLE "poc_call_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "poc_call_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"call_id" uuid NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);

--> statement-breakpoint
CREATE TABLE "poc_private"."negotiations" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"authority_revision" integer NOT NULL,
	"load_id" text NOT NULL,
	"offer_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"listed_cents" bigint NOT NULL,
	"max_cents" bigint NOT NULL,
	"offered_cents" bigint NOT NULL,
	"agreed_cents" bigint,
	"counter_rounds" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "negotiations_max_at_least_listed" CHECK ("poc_private"."negotiations"."max_cents" >= "poc_private"."negotiations"."listed_cents"),
	CONSTRAINT "negotiations_offered_within_max" CHECK ("poc_private"."negotiations"."offered_cents" > 0 and "poc_private"."negotiations"."offered_cents" <= "poc_private"."negotiations"."max_cents"),
	CONSTRAINT "negotiations_agreed_within_max" CHECK ("poc_private"."negotiations"."agreed_cents" > 0 and "poc_private"."negotiations"."agreed_cents" <= "poc_private"."negotiations"."max_cents"),
	CONSTRAINT "negotiations_counter_rounds_check" CHECK ("poc_private"."negotiations"."counter_rounds" between 0 and 3),
	CONSTRAINT "negotiations_listed_cents_check" CHECK ("poc_private"."negotiations"."listed_cents" > 0),
	CONSTRAINT "negotiations_status_check" CHECK ("poc_private"."negotiations"."status" in ('idle','offered','agreed','rejected','failed'))
);

--> statement-breakpoint
CREATE TABLE "poc_private"."offer_receipts" (
	"call_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"fingerprint" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "offer_receipts_call_id_offer_id_pk" PRIMARY KEY("call_id","offer_id")
);

--> statement-breakpoint
CREATE TABLE "poc_private"."operation_receipts" (
	"call_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"phase" text NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "operation_receipts_call_id_operation_id_phase_pk" PRIMARY KEY("call_id","operation_id","phase")
);

--> statement-breakpoint
CREATE TABLE "poc_private"."operator_access" (
	"key_hash" text PRIMARY KEY NOT NULL
);

--> statement-breakpoint
CREATE TABLE "poc_private"."otp_receipts" (
	"call_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"authority_revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "otp_receipts_call_id_operation_id_pk" PRIMARY KEY("call_id","operation_id")
);

--> statement-breakpoint
CREATE TABLE "poc_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detail" text NOT NULL,
	"callback_number" text,
	"source_key" text NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution_note" text,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "poc_reviews_call_id_reason_key" UNIQUE("call_id","reason"),
	CONSTRAINT "poc_reviews_status_check" CHECK ("poc_reviews"."status" in ('open','reviewed'))
);

--> statement-breakpoint
ALTER TABLE "poc_call_events" ADD CONSTRAINT "poc_call_events_call_id_poc_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."poc_calls"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "poc_private"."negotiations" ADD CONSTRAINT "negotiations_call_id_poc_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."poc_calls"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "poc_private"."offer_receipts" ADD CONSTRAINT "offer_receipts_call_id_poc_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."poc_calls"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "poc_private"."operation_receipts" ADD CONSTRAINT "operation_receipts_call_id_poc_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."poc_calls"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "poc_private"."otp_receipts" ADD CONSTRAINT "otp_receipts_call_id_poc_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."poc_calls"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "poc_reviews" ADD CONSTRAINT "poc_reviews_call_id_poc_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."poc_calls"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "poc_calls_recent" ON "poc_calls" USING btree ("created_at" DESC NULLS LAST,"id");
--> statement-breakpoint
CREATE UNIQUE INDEX "poc_booking_load_claim" ON "poc_calls" USING btree (("booking"->>'load_id')) WHERE "poc_calls"."booking"->>'status' in ('pending','confirmed','uncertain') and coalesce("poc_calls"."booking"->>'simulated','false') <> 'true';
--> statement-breakpoint
CREATE INDEX "poc_events_call_time" ON "poc_call_events" USING btree ("call_id","created_at");
--> statement-breakpoint
CREATE INDEX "poc_events_send_time" ON "poc_call_events" USING btree ("created_at") WHERE "poc_call_events"."event" = 'otp_requested';
--> statement-breakpoint
CREATE INDEX "poc_reviews_open" ON "poc_reviews" USING btree ("updated_at" DESC NULLS LAST) WHERE "poc_reviews"."status" = 'open';

-- Access permissions
-- The migration owner (Twin SQL API role) retains access. Runtime credentials
-- stay server-side. Grant a separately provisioned backend role explicitly;
-- anonymous REST gateway roles must never inherit it.
REVOKE ALL ON SCHEMA poc_private FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA poc_private FROM PUBLIC;
REVOKE ALL ON public.poc_calls, public.poc_call_events, public.poc_reviews FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.poc_call_events_id_seq FROM PUBLIC;

-- Twin grants its REST role access to newly created public tables by default.
-- Revoke those explicit grants too; revoking PUBLIC alone is insufficient.
-- The role is absent in standalone PostgreSQL installations.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON SCHEMA poc_private FROM app_user;
    REVOKE ALL ON ALL TABLES IN SCHEMA poc_private FROM app_user;
    REVOKE ALL ON public.poc_calls, public.poc_call_events, public.poc_reviews FROM app_user;
    REVOKE ALL ON SEQUENCE public.poc_call_events_id_seq FROM app_user;
  END IF;
END
$$;
COMMIT;
