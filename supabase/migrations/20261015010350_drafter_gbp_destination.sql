-- Bind drafted GBP posts to the client's already-verified Zernio location.
-- No existing post, approval, publisher switch or account binding is changed.
-- The brief still cannot supply a GBP account. Resolve it from the persisted
-- client binding inside drafter_write's existing transaction, before review.
do $migration$
declare
  definition text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
  anchor text := '  insert into drafter_runs (client_id, requested_via, requested_by, target, brief_version, brief_hash, brief,';
  binding text := $binding$
  -- drafter_gbp_destination_v1: only an already-bound client location.
  if v_channel = 'google_business' and exists (
    select 1 from publisher_client_transports
     where client_id = v_client and gbp_transport = 'zernio'
  ) then
    begin
      select id into strict v_account
        from social_accounts
       where client_id = v_client and platform::text = 'google_business'
         and publish_provider = 'zernio'
         and nullif(btrim(publish_account_id), '') is not null
         and nullif(btrim(publish_page_id), '') is not null
         and publish_verified_at is not null
       for share;
    exception
      when no_data_found then
        raise exception 'A Zernio Business Profile draft needs the client''s verified location binding' using errcode = 'check_violation';
      when too_many_rows then
        raise exception 'A Zernio Business Profile draft needs exactly one verified location binding' using errcode = 'check_violation';
    end;
  end if;

$binding$;
begin
  if strpos(definition, 'drafter_gbp_destination_v1') > 0 then return; end if;
  if strpos(definition, 'Only a Facebook draft names a social account') = 0
     or strpos(definition, 'v_account uuid') = 0
     or (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) then
    raise exception 'Unexpected drafter_write definition; review before applying the GBP destination fix';
  end if;
  execute replace(definition, anchor, binding || anchor);
end;
$migration$;
