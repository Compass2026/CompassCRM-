-- site-push (Edge Function) records what it committed, so the Foundation tab
-- can show "last pushed" without opening a session transcript.
alter table sites
  add column if not exists last_pushed_at timestamptz,
  add column if not exists last_commit_url text;
