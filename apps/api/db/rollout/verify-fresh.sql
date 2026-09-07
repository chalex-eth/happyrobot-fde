-- Run after reset, baseline and operator-key registration, before app restart.
SELECT
  current_user AS sql_role,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='poc_private'
    OR (table_schema='public' AND table_name IN ('poc_calls','poc_call_events','poc_reviews'))) AS app_tables,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='poc_private' OR (n.nspname='public' AND p.proname LIKE 'poc_%')) AS legacy_functions,
  (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.poc_calls'::regclass
    AND NOT tgisinternal) AS call_triggers,
  (SELECT count(*) FROM public.poc_calls) AS calls,
  (SELECT count(*) FROM public.poc_call_events) AS events,
  (SELECT count(*) FROM public.poc_reviews) AS reviews,
  (SELECT count(*) FROM poc_private.operation_receipts) AS operation_receipts,
  (SELECT count(*) FROM poc_private.operator_access) AS operator_keys,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='poc_calls' AND column_name='revision' AND data_type='bigint'
    AND is_nullable='NO') AS revision_ready,
  has_table_privilege(current_user, 'public.poc_calls', 'SELECT')
    AND has_table_privilege(current_user, 'public.poc_calls', 'INSERT')
    AND has_table_privilege(current_user, 'public.poc_calls', 'UPDATE') AS backend_access,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    has_table_privilege('app_user', 'public.poc_calls', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('app_user', 'public.poc_call_events', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('app_user', 'public.poc_reviews', 'SELECT,INSERT,UPDATE,DELETE')
    ELSE false END AS rest_has_table_access;
