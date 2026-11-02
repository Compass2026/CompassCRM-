-- Client email is mediated by client-mailbox, never directly by a portal table grant.
-- No existing portal access or outbound SMS settings are changed.
create table client_mailboxes (
  client_id uuid primary key references clients(id),
  expected_email text not null check (expected_email = lower(expected_email) and expected_email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  enabled boolean not null default true,
  connected_email text,
  connected_at timestamptz,
  connected_by uuid references auth.users(id),
  token_secret text,
  generation uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  check (connected_email is null or connected_email = expected_email)
);
create table client_mailbox_oauth (
  state_hash text primary key,
  client_id uuid not null references client_mailboxes(client_id),
  actor_id uuid not null references auth.users(id),
  generation uuid not null,
  verifier text not null,
  return_to text not null,
  expires_at timestamptz not null default now() + interval '10 minutes'
);
create index on client_mailbox_oauth(expires_at);
create table client_email_threads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references client_mailboxes(client_id),
  inquiry_id uuid not null,
  recipient text not null,
  subject text not null check (length(subject) between 1 and 200 and subject !~ '[\r\n]'),
  provider_thread_id text,
  synced_at timestamptz,
  unique (inquiry_id, client_id),
  unique (id, client_id),
  unique (client_id, provider_thread_id),
  foreign key (inquiry_id, client_id) references inquiries(id, client_id)
);
create table client_email_drafts (
  client_id uuid not null references client_mailboxes(client_id),
  inquiry_id uuid not null,
  actor_id uuid not null references auth.users(id),
  body text not null check (length(body) <= 10000),
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  primary key (client_id, inquiry_id, actor_id),
  foreign key (inquiry_id, client_id) references inquiries(id, client_id)
);
create table client_email_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  thread_id uuid not null,
  actor_id uuid references auth.users(id),
  request_id uuid,
  provider_message_id text,
  rfc_message_id text not null,
  sender text not null,
  recipient text not null,
  subject text not null,
  body text not null check (length(body) <= 100000),
  status text not null check (status in ('unknown', 'accepted', 'received', 'failed')),
  error_code text,
  message_at timestamptz not null default now(),
  unique (client_id, request_id),
  unique (client_id, provider_message_id),
  unique (client_id, rfc_message_id),
  foreign key (thread_id, client_id) references client_email_threads(id, client_id)
);
create index on client_email_messages(thread_id, message_at);
create index on client_email_messages(client_id, status);

-- Service-only atomic OAuth consume. Expired/nonexistent states return null.
create function client_mailbox_consume_state(p_hash text) returns jsonb
language sql security invoker set search_path = public as $$
  with consumed as (delete from client_mailbox_oauth where state_hash = p_hash returning *)
  select to_jsonb(consumed) from consumed where expires_at > now();
$$;
revoke all on function client_mailbox_consume_state(text) from public, anon, authenticated;
grant execute on function client_mailbox_consume_state(text) to service_role;

-- Serialize send reservation by thread. The saved draft revision is the idempotency key.
-- Unknown sends block all new sends in that conversation until reconciled.
create function client_mailbox_claim_send(p_client uuid, p_inquiry uuid, p_actor uuid, p_revision uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare t client_email_threads; d client_email_drafts; m client_email_messages; b client_mailboxes;
begin
  select * into b from client_mailboxes where client_id=p_client and enabled and connected_email=expected_email for share;
  if not found then raise exception 'mailbox_not_connected'; end if;
  select * into t from client_email_threads where client_id=p_client and inquiry_id=p_inquiry for update;
  if not found then raise exception 'thread_not_found'; end if;
  select * into m from client_email_messages where client_id=p_client and request_id=p_revision;
  if found then
    if m.actor_id<>p_actor or m.thread_id<>t.id then raise exception 'request_conflict'; end if;
    return jsonb_build_object('claimed',false,'message',to_jsonb(m));
  end if;
  if exists(select 1 from client_email_messages where thread_id=t.id and status='unknown') then
    raise exception 'send_uncertain_refresh_first';
  end if;
  select * into d from client_email_drafts where client_id=p_client and inquiry_id=p_inquiry and actor_id=p_actor and revision=p_revision for update;
  if not found or length(btrim(d.body))=0 then raise exception 'save_draft_first'; end if;
  insert into client_email_messages(client_id,thread_id,actor_id,request_id,rfc_message_id,sender,recipient,subject,body,status)
  values(p_client,t.id,p_actor,p_revision,'<crm-'||p_revision||'@'||split_part(b.connected_email,'@',2)||'>',b.connected_email,t.recipient,t.subject,d.body,'unknown') returning * into m;
  return jsonb_build_object('claimed',true,'message',to_jsonb(m));
end $$;
revoke all on function client_mailbox_claim_send(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function client_mailbox_claim_send(uuid,uuid,uuid,uuid) to service_role;

-- No browser-readable credential references, OAuth state, drafts or mailbox data.
-- The Edge Function authenticates the real actor, rechecks active membership and
-- CRM settings, then scopes every operation by client and inquiry.
alter table client_mailboxes enable row level security;
alter table client_mailbox_oauth enable row level security;
alter table client_email_threads enable row level security;
alter table client_email_drafts enable row level security;
alter table client_email_messages enable row level security;
revoke all on client_mailboxes,client_mailbox_oauth,client_email_threads,client_email_drafts,client_email_messages from public,anon,authenticated;
grant all on client_mailboxes,client_mailbox_oauth,client_email_threads,client_email_drafts,client_email_messages to service_role;
