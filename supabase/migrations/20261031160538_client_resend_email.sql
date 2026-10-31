-- Provider-specific configuration remains service-only. No access changes.
alter table client_mailboxes add column provider text not null default 'google' check (provider in ('google','resend'));
alter table client_mailboxes add column reply_domain text;
alter table client_mailboxes add column sender_name text;
alter table client_mailboxes add column resend_ready boolean not null default false;
alter table client_mailboxes add column api_key_secret text;
alter table client_email_threads add column reply_token uuid not null default gen_random_uuid() unique;
alter table client_email_messages add column delivery_status text check (delivery_status in ('sent','delivered','delayed','bounced','complained','failed','suppressed'));
alter table client_email_messages add column delivery_at timestamptz;
create table client_email_webhook_events (
  id text primary key, event_type text not null, received_at timestamptz not null default now()
);
create table client_email_suppressions (
  client_id uuid not null references clients(id), email text not null, reason text not null,
  created_at timestamptz not null default now(), primary key(client_id,email)
);
alter table client_email_webhook_events enable row level security;
alter table client_email_suppressions enable row level security;
revoke all on client_email_webhook_events,client_email_suppressions from public,anon,authenticated;
grant all on client_email_webhook_events,client_email_suppressions to service_role;

-- A replay receipt and the message mutation commit together; out-of-order
-- delivery events cannot undo a bounce/complaint or downgrade delivery.
create function client_email_record_event(p jsonb) returns void
language plpgsql security invoker set search_path=public as $$
declare m client_email_messages; t client_email_threads; b client_mailboxes; d text;
begin
  insert into client_email_webhook_events(id,event_type) values(p->>'event_id',p->>'type') on conflict do nothing;
  if not found then return; end if;
  if p->>'type'='email.received' then
    select * into t from client_email_threads where reply_token=(p->>'reply_token')::uuid for update;
    if not found or t.recipient<>p->>'sender' then return; end if;
    select * into b from client_mailboxes where client_id=t.client_id and enabled and provider='resend';
    if not found or lower(p->>'recipient')<>('r.'||t.reply_token::text||'@'||b.reply_domain) then return; end if;
    insert into client_email_messages(client_id,thread_id,provider_message_id,rfc_message_id,sender,recipient,subject,body,status,message_at)
    values(t.client_id,t.id,p->>'provider_id',p->>'rfc_id',p->>'sender',p->>'recipient',left(p->>'subject',200),left(p->>'body',100000),'received',(p->>'at')::timestamptz)
    on conflict do nothing;
    update client_email_threads set synced_at=now() where id=t.id;
  else
    select * into m from client_email_messages where id=(p->>'message_id')::uuid for update;
    if not found or m.sender<>p->>'sender' or m.recipient<>p->>'recipient' or (m.provider_message_id is not null and m.provider_message_id<>p->>'provider_id') then return; end if;
    if not exists(select 1 from client_mailboxes where client_id=m.client_id and provider='resend') then return; end if;
    d:=p->>'delivery';
    if d in ('bounced','complained','suppressed') then
      insert into client_email_suppressions(client_id,email,reason) values(m.client_id,m.recipient,d) on conflict do nothing;
    end if;
    update client_email_messages set provider_message_id=p->>'provider_id', status='accepted',
      delivery_status=case when delivery_status in ('bounced','complained','suppressed','failed') then delivery_status
        when d in ('bounced','complained','suppressed','failed') then d
        when delivery_status='delivered' then delivery_status else d end,
      delivery_at=greatest(delivery_at,(p->>'at')::timestamptz)
    where id=m.id;
    delete from client_email_drafts where client_id=m.client_id and actor_id=m.actor_id and revision=m.request_id;
  end if;
end $$;
revoke all on function client_email_record_event(jsonb) from public,anon,authenticated;
grant execute on function client_email_record_event(jsonb) to service_role;

create or replace function client_mailbox_claim_send(p_client uuid, p_inquiry uuid, p_actor uuid, p_revision uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare t client_email_threads; d client_email_drafts; m client_email_messages; b client_mailboxes;
begin
  select * into b from client_mailboxes where client_id=p_client and enabled and connected_email=expected_email for update;
  if not found then raise exception 'mailbox_not_connected'; end if;
  if b.provider='resend' and (not b.resend_ready or b.reply_domain is null or b.api_key_secret is null) then raise exception 'email_not_ready'; end if;
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
  if exists(select 1 from client_email_suppressions where client_id=p_client and email=t.recipient) then raise exception 'recipient_suppressed'; end if;
  if (select count(*) from client_email_messages where client_id=p_client and actor_id=p_actor and message_at>now()-interval '1 minute')>=20 then raise exception 'rate_limited'; end if;
  select * into d from client_email_drafts where client_id=p_client and inquiry_id=p_inquiry and actor_id=p_actor and revision=p_revision for update;
  if not found or length(btrim(d.body))=0 then raise exception 'save_draft_first'; end if;
  insert into client_email_messages(client_id,thread_id,actor_id,request_id,rfc_message_id,sender,recipient,subject,body,status)
  values(p_client,t.id,p_actor,p_revision,'<crm-'||p_revision||'@'||split_part(b.connected_email,'@',2)||'>',b.connected_email,t.recipient,t.subject,d.body,'unknown') returning * into m;
  return jsonb_build_object('claimed',true,'message',to_jsonb(m));
end $$;
revoke all on function client_mailbox_claim_send(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function client_mailbox_claim_send(uuid,uuid,uuid,uuid) to service_role;

