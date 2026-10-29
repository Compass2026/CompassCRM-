-- Undoes 20261029160000: content_review_batch's social review links point at
-- /clients/<client>/posts/<post> again (a CRM 404). Run as one transaction;
-- no row is touched.
do $rollback$
declare
  definition text := pg_get_functiondef('public.content_review_batch(uuid,text)'::regprocedure);
  a text := $a$'/social/' || p.id)$a$;
  r text := $r$'/posts/' || p.id)$r$;
begin
  if (length(definition) - length(replace(definition, a, ''))) <> length(a) then
    raise exception 'Unexpected content_review_batch definition; nothing rolled back';
  end if;
  execute replace(definition, a, r);
end;
$rollback$;
