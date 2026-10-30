-- Rollback of 20261030190000_authority_core_scope.sql. authority_fingerprint()
-- returns to its 0048 definition (md5 308d6200…); the two read functions go.
-- No row is touched. Deploy the previous authority-run first: it reads
-- authority_input_scoped().
do $rollback$
declare
  definition text := pg_get_functiondef('public.authority_fingerprint(uuid)'::regprocedure);
  start_at int := strpos(definition, E',\n    ''core'',');
  end_at int := strpos(definition, E'\n  ));');
begin
  if strpos(definition, '''core''') = 0 then return; end if;
  if start_at = 0 or end_at < start_at then
    raise exception 'Unexpected authority_fingerprint definition; restore it from 0048 by hand';
  end if;
  execute substr(definition, 1, start_at - 1) || substr(definition, end_at);
  if md5(pg_get_functiondef('public.authority_fingerprint(uuid)'::regprocedure)) <> '308d62000db95bcab28f778c82447b9e' then
    raise exception 'authority_fingerprint() did not return to its 0048 definition';
  end if;
end;
$rollback$;
drop function if exists authority_input_scoped(uuid);
drop function if exists authority_core_scope(uuid);
