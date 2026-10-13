-- Summary windows use the same business timezone as reporting measurements.
-- UTC midnight used to reject a legitimate Central-day import as "future".
-- Preserve the existing secure function body/privileges; fail if its specific
-- UTC comparison no longer matches the audited migration version.
DO $$
DECLARE
  fn text;
  old_check constant text := '(r.created_at at time zone ''UTC'')::date';
  new_check constant text := '(r.created_at at time zone ''America/Chicago'')::date';
BEGIN
  SELECT pg_get_functiondef('public.backlink_profile_record(uuid,text,date,date,jsonb)'::regprocedure) INTO fn;
  IF fn IS NULL OR position(old_check IN fn)=0 THEN
    RAISE EXCEPTION 'Backlink summary date check changed; review migration before replacing';
  END IF;
  EXECUTE replace(fn,old_check,new_check);
END $$;
