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
