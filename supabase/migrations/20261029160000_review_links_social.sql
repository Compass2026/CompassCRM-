-- Executive OS review links for Facebook and Business Profile posts open the
-- CRM's post page. content_review_batch (20261019202359) built
-- /clients/<client>/posts/<post>, a route the CRM does not have, so every
-- social review link from Executive OS landed on a 404 after sign-in. The
-- post page is /clients/<client>/social/<post>
-- (src/app/(app)/clients/[clientId]/social/[postId]/page.tsx), the link the
-- CRM's own lists and planner use. Blog links (/drafts/) were already right.
-- One string in the function changes; nothing else (grants are kept by the
-- CREATE OR REPLACE that pg_get_functiondef emits).
-- Rollback: supabase/rollback/20261029160000_review_links_social.down.sql
do $migration$
declare
  definition text := pg_get_functiondef('public.content_review_batch(uuid,text)'::regprocedure);
  a text := $a$'/posts/' || p.id)$a$;
  r text := $r$'/social/' || p.id)$r$;
begin
  if strpos(definition, r) > 0 and strpos(definition, a) = 0 then return; end if;
  if (length(definition) - length(replace(definition, a, ''))) <> length(a) then
    raise exception 'Unexpected content_review_batch definition; review before applying the review-link fix';
  end if;
  execute replace(definition, a, r);
end;
$migration$;

do $verify$
declare d text := pg_get_functiondef('public.content_review_batch(uuid,text)'::regprocedure);
begin
  if strpos(d, $r$'/social/' || p.id)$r$) = 0 or strpos(d, '/posts/') > 0 then
    raise exception 'content_review_batch: social review links still point at /posts/';
  end if;
  if has_function_privilege('anon', 'public.content_review_batch(uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.content_review_batch(uuid,text)', 'execute')
     or not has_function_privilege('service_role', 'public.content_review_batch(uuid,text)', 'execute') then
    raise exception 'content_review_batch: grants changed (service_role only)';
  end if;
end $verify$;
