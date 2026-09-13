-- site-push records which branch it committed to, so the Foundation tab can
-- say "main" or "compass-astro" without inferring it from the Vercel project
-- name. Backfilled from the rule the function applies: a `-astro` project
-- means the build sits on the side branch.
alter table sites add column if not exists branch text;

update sites set branch = case when vercel_project like '%-astro' then 'compass-astro' else 'main' end
where branch is null and last_pushed_at is not null;
