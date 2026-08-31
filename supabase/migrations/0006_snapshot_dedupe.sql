-- Deduplicate snapshots ingested twice by the first sync runs, then make
-- duplicates structurally impossible so the sync can rely on
-- ON CONFLICT DO NOTHING instead of string-matching timestamps.

delete from rank_snapshots a
using rank_snapshots b
where a.keyword_id = b.keyword_id
  and a.location_id = b.location_id
  and a.result_type = b.result_type
  and a.recorded_at = b.recorded_at
  and coalesce(a.source::text, '') = coalesce(b.source::text, '')
  and a.ctid > b.ctid;

delete from grid_snapshots a
using grid_snapshots b
where a.grid_config_id = b.grid_config_id
  and a.keyword_id = b.keyword_id
  and a.recorded_at = b.recorded_at
  and a.ctid > b.ctid;

create unique index rank_snapshots_natural_key
  on rank_snapshots (keyword_id, location_id, result_type, recorded_at, source);

create unique index grid_snapshots_natural_key
  on grid_snapshots (grid_config_id, keyword_id, recorded_at);
