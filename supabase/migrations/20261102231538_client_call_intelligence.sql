-- Additive, per-client rollout. No existing account or channel is enabled here.
alter table client_voice_settings
  add column recording_enabled boolean not null default false,
  add column summaries_enabled boolean not null default false,
  add column email_summaries boolean not null default false,
  add column retention_days integer not null default 30 check(retention_days between 7 and 365),
  add column max_call_seconds integer not null default 3600 check(max_call_seconds between 60 and 7200),
  add column intelligence_service_sid text check(intelligence_service_sid ~ '^GA[0-9a-fA-F]{32}$'),
  add column summary_operator_sid text check(summary_operator_sid ~ '^LY[0-9a-fA-F]{32}$'),
  add column summary_user_ids uuid[] not null default '{}',
  add column updated_by uuid references auth.users(id),
  add column updated_at timestamptz not null default now(),
  add constraint voice_summary_requires_recording check(not summaries_enabled or (recording_enabled and intelligence_service_sid is not null and summary_operator_sid is not null)),
  add constraint voice_email_requires_summary check(not email_summaries or (summaries_enabled and cardinality(summary_user_ids) between 1 and 10));
alter table client_voice_calls
  add column recording_requested boolean not null default false,
  add column recording_consent text not null default 'not_requested' check(recording_consent in ('not_requested','pending','accepted','declined')),
  add column consent_at timestamptz,
  add column consent_child_sid text,
  add column recording_started boolean not null default false,
  add constraint client_voice_calls_id_client_unique unique(id,client_id);

create table client_voice_recordings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id), call_id uuid not null,
  account_sid text not null check(account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  recording_sid text not null unique check(recording_sid ~ '^RE[0-9a-fA-F]{32}$'),
  duration integer not null check(duration >= 0),
  service_sid text, operator_sid text, transcript_sid text,
  state text not null default 'recorded' check(state in ('recorded','queued','submitted','ready','failed','uncertain','deleted')),
  transcript text, summary text,
  expires_at timestamptz not null,
  submitted_at timestamptz, attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(), lease_until timestamptz,
  error_code text, created_at timestamptz not null default now(),
  foreign key(call_id,client_id) references client_voice_calls(id,client_id),
  unique(id,client_id)
);
create index client_voice_recordings_work on client_voice_recordings(next_attempt_at) where state in ('queued','submitted');
create index client_voice_recordings_expiry on client_voice_recordings(expires_at) where state <> 'deleted';
create table client_voice_summary_emails (
  id uuid primary key default gen_random_uuid(), client_id uuid not null,
  recording_id uuid not null, user_id uuid not null references auth.users(id),
  recipient text not null, sender text not null, body text not null,
  status text not null default 'pending' check(status in ('pending','accepted','failed','uncertain','suppressed')),
  provider_id text, delivery_status text, delivery_at timestamptz, first_attempt_at timestamptz, attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(), lease_until timestamptz,
  created_at timestamptz not null default now(),
  foreign key(recording_id,client_id) references client_voice_recordings(id,client_id),
  unique(recording_id,user_id)
);
create index client_voice_summary_emails_work on client_voice_summary_emails(next_attempt_at) where status='pending';
alter table client_voice_recordings enable row level security;
alter table client_voice_summary_emails enable row level security;
revoke all on client_voice_recordings,client_voice_summary_emails from public,anon,authenticated;
grant all on client_voice_recordings,client_voice_summary_emails to service_role;

-- Atomic leases survive worker restarts and prevent concurrent paid submissions.
create function client_voice_claim_recording() returns setof client_voice_recordings
language sql security invoker set search_path=public,pg_catalog as $$
  update client_voice_recordings r set lease_until=now()+interval '4 minutes', attempts=attempts+1
  where r.id=(select x.id from client_voice_recordings x
    where (x.lease_until is null or x.lease_until<now()) and x.next_attempt_at<=now()
      and (x.expires_at<=now() and x.state<>'deleted' or x.state in ('queued','submitted'))
    order by x.expires_at<=now() desc,x.next_attempt_at for update skip locked limit 1)
  returning r.*;
$$;
create function client_voice_claim_email() returns setof client_voice_summary_emails
language sql security invoker set search_path=public,pg_catalog as $$
  update client_voice_summary_emails e set lease_until=now()+interval '4 minutes',attempts=attempts+1,
    first_attempt_at=coalesce(first_attempt_at,now())
  where e.id=(select x.id from client_voice_summary_emails x where x.status='pending'
    and (x.lease_until is null or x.lease_until<now()) and x.next_attempt_at<=now()
    order by x.next_attempt_at for update skip locked limit 1) returning e.*;
$$;
revoke all on function client_voice_claim_recording(),client_voice_claim_email() from public,anon,authenticated;
grant execute on function client_voice_claim_recording(),client_voice_claim_email() to service_role;

create function client_voice_summary_email_event(p jsonb) returns void
language plpgsql security invoker set search_path=public,pg_catalog as $$
declare e client_voice_summary_emails; d text:=p->>'delivery';
begin
  if d not in ('sent','delivered','delayed','bounced','complained','failed','suppressed') then return; end if;
  select * into e from client_voice_summary_emails where id=(p->>'message_id')::uuid for update;
  if not found or lower(e.recipient) is distinct from lower(p->>'recipient') or lower(e.sender) is distinct from lower(p->>'sender')
    or (e.provider_id is not null and e.provider_id<>p->>'provider_id') then return; end if;
  insert into client_email_webhook_events(id,event_type) values(p->>'event_id',p->>'type') on conflict do nothing;
  if not found then return; end if;
  if d in ('bounced','complained','suppressed') then
    insert into client_email_suppressions(client_id,email,reason) values(e.client_id,lower(e.recipient),d)
      on conflict(client_id,email) do update set reason=excluded.reason;
  end if;
  if e.delivery_status in ('bounced','complained','suppressed') then return; end if;
  if e.delivery_status='delivered' and d in ('sent','delayed') then return; end if;
  if e.delivery_at is not null and e.delivery_at>(p->>'at')::timestamptz and d not in ('bounced','complained','suppressed') then return; end if;
  update client_voice_summary_emails set provider_id=p->>'provider_id',status='accepted',delivery_status=d,delivery_at=(p->>'at')::timestamptz where id=e.id;
end $$;
revoke all on function client_voice_summary_email_event(jsonb) from public,anon,authenticated;
grant execute on function client_voice_summary_email_event(jsonb) to service_role;
