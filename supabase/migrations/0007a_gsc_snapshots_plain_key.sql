-- Plain-column unique key so upsert ... on conflict works via PostgREST;
-- the sync always writes page as '' when absent.
drop index if exists gsc_snapshots_natural_key;
create unique index gsc_snapshots_natural_key
  on gsc_snapshots (client_id, query, page, period_start, period_end);
alter table gsc_snapshots alter column page set default '';
