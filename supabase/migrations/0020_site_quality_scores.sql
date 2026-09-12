-- Where the site quality gate's report lands, so the number is on the record
-- and not only in a session transcript.
alter table sites
  add column if not exists quality jsonb,
  add column if not exists quality_checked_at timestamptz;

comment on column sites.quality is
  'Latest scripts/site-quality-gate.mjs report: {pass, score:{seo,aeo,geo}, failures[], warnings[], placeholders, pages}';
