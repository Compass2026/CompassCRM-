-- Tests for migration 0065 (Communications: per-subaccount Vault access and
-- Twilio's mixed-case SIDs), run by scripts/test-portal-sandbox.sh on the
-- same replay. Own harness schema (cs) and fictional clients; every secret
-- value here is a made-up placeholder, and no check prints a value.
--
-- Callers, as they reach production:
--   service  psql as authenticator, role service_role (the Edge Functions,
--            the same identity PostgREST gives them)
--   person   psql as authenticator, role authenticated, team JWT
--   stranger psql as authenticator, role authenticated, a non-team sign-in
--   worker   psql as postgres

\set team     '00000000-0000-4000-a000-000000000001'
\set stranger '00000000-0000-4000-a000-000000000014'

\o /dev/null
create schema cs;
create table cs.results (n serial, status text, name text, detail text);
grant usage on schema cs to anon, authenticated, service_role, authenticator;
grant insert, select on cs.results to anon, authenticated, service_role, authenticator;
grant usage on sequence cs.results_n_seq to anon, authenticated, service_role, authenticator;
create function cs.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into cs.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function cs.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function cs.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function cs.id(p_k text) returns uuid language sql immutable as $$ select md5('cs:' || p_k)::uuid $$;
grant execute on all functions in schema cs to anon, authenticated, service_role, authenticator;

-- A subaccount SID in Twilio's usual lower-case form, and its long Vault
-- names: TWILIO_SUB_<34-character SID>_AUTH_TOKEN is 56 characters.
create table cs.k (k text primary key, v text);
grant select on cs.k to anon, authenticated, service_role, authenticator;
insert into cs.k values
  ('sub',    'AC' || md5('cs-sub')),
  ('other',  'AC' || md5('cs-other')),
  ('upper',  'AC' || upper(md5('cs-upper'))),
  ('mixed',  'AC' || 'aBcDeF0123456789' || 'AbCdEf0123456789'),
  ('amb',    'AC' || md5('cs-amb')),
  ('nokey',  'AC' || md5('cs-nokey'));
create function cs.k(p text) returns text language sql stable as $$ select v from cs.k where k = p $$;
grant execute on function cs.k(text) to anon, authenticated, service_role, authenticator;

select vault.create_secret('placeholder-token-' || repeat('t', 14), 'TWILIO_SUB_' || cs.k('sub') || '_AUTH_TOKEN');
select vault.create_secret('SK' || repeat('a', 32), 'TWILIO_SUB_' || cs.k('sub') || '_API_KEY');
select vault.create_secret('placeholder-key-secret', 'TWILIO_SUB_' || cs.k('sub') || '_API_SECRET');
select vault.create_secret('placeholder-other-token', 'TWILIO_SUB_' || cs.k('other') || '_AUTH_TOKEN');
-- Stored by hand under the SID with its hex in upper case, with a newline.
select vault.create_secret(E'placeholder-upper-token\n', 'TWILIO_SUB_' || upper(cs.k('upper')) || '_AUTH_TOKEN');
-- Two names that differ only in case, neither the exact one: ambiguous.
select vault.create_secret('placeholder-amb-1', 'TWILIO_SUB_' || upper(cs.k('amb')) || '_AUTH_TOKEN');
select vault.create_secret('placeholder-amb-2', 'TWILIO_SUB_' || 'AC' || upper(substr(cs.k('amb'), 3, 16)) || substr(cs.k('amb'), 19) || '_AUTH_TOKEN');

insert into clients (id, name, city, state, status) values (cs.id('a'), 'Secrets Safety Co', 'Hannibal', 'MO', 'active');

-- ── S. Static ───────────────────────────────────────────────────────────────
do $$
begin
  perform cs.ok('S1 communication_subaccount_secrets: the service role only',
    has_function_privilege('service_role', 'communication_subaccount_secrets(text)', 'execute')
    and not has_function_privilege('authenticated', 'communication_subaccount_secrets(text)', 'execute')
    and not has_function_privilege('anon', 'communication_subaccount_secrets(text)', 'execute'));
  perform cs.ok('S2 communication_vault_match is internal (no API role executes it)',
    not has_function_privilege('service_role', 'communication_vault_match(text)', 'execute')
    and not has_function_privilege('authenticated', 'communication_vault_match(text)', 'execute')
    and not has_function_privilege('anon', 'communication_vault_match(text)', 'execute'));
  perform cs.ok('S3 communication_secret_status: teammates and the service role, never anon',
    has_function_privilege('authenticated', 'communication_secret_status(text)', 'execute')
    and has_function_privilege('service_role', 'communication_secret_status(text)', 'execute')
    and not has_function_privilege('anon', 'communication_secret_status(text)', 'execute'));
  perform cs.ok('S4 every Communications SID constraint accepts [0-9a-fA-F]',
    not exists (select 1 from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c'
                and conrelid::regclass::text like 'communication%' and pg_get_constraintdef(oid) ~ '\[0-9a-f\]\{32\}')
    and (select count(*) from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c'
         and conrelid::regclass::text like 'communication%' and pg_get_constraintdef(oid) ~ '\[0-9a-fA-F\]\{32\}') = 5);
  perform cs.ok('S5 the three MessageSid checks accept [0-9a-fA-F]',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in
       ('communication_record_inbound', 'communication_mark_sent', 'communication_record_status')
       and prosrc ~ '\[0-9a-fA-F\]\{32\}' and prosrc !~ '\[0-9a-f\]\{32\}') = 3);
  perform cs.ok('S6 the long dynamic name is 56 characters', length('TWILIO_SUB_' || cs.k('sub') || '_AUTH_TOKEN') = 56);
end $$;

-- ── V. The Edge Functions' path: authenticator + service_role ───────────────
\c - authenticator
set role service_role;
select cs.as_user('service_role', null);
do $$
declare
  r jsonb;
  e text;
  v text;
begin
  -- The production symptom, reproduced both ways: get_secret() answers a
  -- 56-character dynamic name through this identity, and answers null (not
  -- an error) for a name that differs only in its SID.
  v := get_secret('TWILIO_SUB_' || cs.k('sub') || '_AUTH_TOKEN');
  perform cs.ok('V1 get_secret: a 56-character TWILIO_SUB_<sid>_AUTH_TOKEN resolves for the Edge Functions'' identity',
    v is not null and length(v) = 32, coalesce(length(v)::text, 'null'));
  perform cs.ok('V2 get_secret: the same name with another SID answers null (what production saw)',
    get_secret('TWILIO_SUB_' || cs.k('nokey') || '_AUTH_TOKEN') is null);

  r := communication_subaccount_secrets(cs.k('sub'));
  perform cs.ok('V3 one read returns the key, its secret and the Auth Token with their exact names',
    length(r->>'auth_token') = 32 and r->>'api_key' = 'SK' || repeat('a', 32) and r->>'api_secret' = 'placeholder-key-secret'
    and r->>'auth_token_name' = 'TWILIO_SUB_' || cs.k('sub') || '_AUTH_TOKEN'
    and r->>'auth_token_found_as' = r->>'auth_token_name' and r->>'account_sid' = cs.k('sub'));
  perform cs.ok('V4 the other subaccounts Vault holds an Auth Token for are listed (SIDs only)',
    r->'other_auth_token_accounts' ? cs.k('other') and not (r->'other_auth_token_accounts' ? cs.k('sub'))
    and r::text !~ 'placeholder-other-token');

  r := communication_subaccount_secrets(cs.k('upper'));
  perform cs.ok('V5 a token stored under the SID in another letter case is found, trimmed, and named as stored',
    r->>'auth_token' = 'placeholder-upper-token'
    and r->>'auth_token_found_as' = 'TWILIO_SUB_' || upper(cs.k('upper')) || '_AUTH_TOKEN'
    and r->>'auth_token_name' = 'TWILIO_SUB_' || cs.k('upper') || '_AUTH_TOKEN', r->>'auth_token_found_as');

  r := communication_subaccount_secrets(cs.k('amb'));
  perform cs.ok('V6 two case-variants and no exact name: nothing is guessed', r->>'auth_token' is null and r->>'auth_token_found_as' is null);

  r := communication_subaccount_secrets(cs.k('nokey'));
  perform cs.ok('V7 a missing credential is null, with the name it should have',
    r->>'auth_token' is null and r->>'api_key' is null and r->>'api_secret' is null
    and r->>'auth_token_name' = 'TWILIO_SUB_' || cs.k('nokey') || '_AUTH_TOKEN'
    and r->'other_auth_token_accounts' ? cs.k('sub'));

  r := communication_subaccount_secrets(cs.k('mixed'));
  perform cs.ok('V8 a mixed-case SID is a valid argument', r->>'account_sid' = cs.k('mixed'));
  e := cs.try('select communication_subaccount_secrets(''TWILIO_API_SECRET'')');
  perform cs.ok('V9 anything but an account SID is refused (no arbitrary Vault read)', e like '22023%', e);
  e := cs.try('select communication_vault_match(''TWILIO_API_SECRET'')');
  perform cs.ok('V10 the service role cannot call the matcher directly', e like '42501%', e);

  r := communication_secret_status(cs.k('sub'));
  perform cs.ok('V11 status for the service role: yes / no only',
    (r->>'parent')::boolean is not null and (r->>'subaccount_key')::boolean and (r->>'subaccount_auth_token')::boolean
    and r::text !~ 'placeholder');

  -- Mixed-case SIDs through 0063's write functions.
  r := communication_register_account(jsonb_build_object('client_id', cs.id('a'), 'account_sid', cs.k('mixed'), 'friendly_name', 'Compass - Secrets Safety Co'));
  perform cs.ok('V12 a subaccount SID with upper-case hex registers', r ? 'account_id');
end $$;
reset role;

\c - supabase_admin
insert into client_communication_settings (client_id, enabled) values (cs.id('a'), true);
\c - authenticator
set role service_role;
select cs.as_user('service_role', null);
do $$
declare r jsonb; e text;
begin
  r := communication_register_number(jsonb_build_object('client_id', cs.id('a'), 'number_sid', 'PN' || 'ABCDEF0123456789abcdef0123456789',
    'phone_number', '+18005550188', 'number_type', 'toll_free', 'sms', true));
  perform cs.ok('V13 a phone number SID with upper-case hex registers', r ? 'number_id');
  r := communication_record_inbound(jsonb_build_object('message_sid', 'SM' || 'ABCDEF0123456789ABCDEF0123456789',
    'account_sid', cs.k('mixed'), 'to', '+18005550188', 'from', '+15735550177', 'body', 'Hello'));
  perform cs.ok('V14 an inbound MessageSid with upper-case hex is recorded once', (r->>'duplicate')::boolean = false);
  r := communication_record_status(jsonb_build_object('message_sid', 'SM' || 'ABCDEF0123456789ABCDEF0123456789',
    'account_sid', cs.k('mixed'), 'status', 'received'));
  perform cs.ok('V15 a status callback with an upper-case-hex MessageSid is accepted', r->>'result' in ('unchanged', 'updated'), r::text);
  e := cs.try('select communication_record_inbound(''{"message_sid":"SMxyz","account_sid":"' || cs.k('mixed') || '","to":"+18005550188","from":"+15735550177"}'')');
  perform cs.ok('V16 a malformed MessageSid is still refused', e like '22023%', e);
end $$;
reset role;

-- ── P. People ───────────────────────────────────────────────────────────────
set role authenticated;
select cs.as_user('authenticated', :'team');
do $$
declare r jsonb; e text;
begin
  e := cs.try(format('select communication_subaccount_secrets(%L)', cs.k('sub')));
  perform cs.ok('P1 a teammate cannot read a subaccount''s secrets', e like '42501%', e);
  r := communication_secret_status(cs.k('sub'));
  perform cs.ok('P2 a teammate sees yes / no and the expected name, never a value',
    (r->>'subaccount_auth_token')::boolean and (r->>'subaccount_key')::boolean
    and r->>'auth_token_name' = 'TWILIO_SUB_' || cs.k('sub') || '_AUTH_TOKEN' and r::text !~ 'placeholder');
  r := communication_secret_status(cs.k('nokey'));
  perform cs.ok('P3 a missing token reads No, naming the secret and the SIDs that do have one',
    not (r->>'subaccount_auth_token')::boolean and r->'other_auth_token_accounts' ? cs.k('sub'));
  r := communication_secret_status(null);
  perform cs.ok('P4 with no subaccount yet only the parent is answered', not (r->>'subaccount_auth_token')::boolean and r ? 'parent');
end $$;
select cs.as_user('authenticated', :'stranger');
do $$
declare e text;
begin
  e := cs.try(format('select communication_secret_status(%L)', cs.k('sub')));
  perform cs.ok('P5 a non-team sign-in is refused the status', e like '42501%', e);
end $$;
reset role;
set role anon;
select cs.as_user('anon', null);
do $$
declare e text;
begin
  e := cs.try(format('select communication_secret_status(%L)', cs.k('sub')));
  perform cs.ok('P6 anon is refused', e like '42501%', e);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── W. The worker's SQL ─────────────────────────────────────────────────────
\c - postgres
do $$
declare e text;
begin
  e := cs.try(format('select communication_secret_status(%L)', cs.k('sub')));
  perform cs.ok('W1 the worker''s SQL is not a teammate for the status', e like '42501%', e);
end $$;

-- ── Teardown ────────────────────────────────────────────────────────────────
\c - supabase_admin
delete from vault.secrets where name like 'TWILIO_SUB_%' and name ilike any (array(select '%' || v || '%' from cs.k));
delete from clients where id = cs.id('a');

\c - postgres
\o
\pset footer off
select status, count(*) from cs.results group by status order by status;
select n, status, name, detail from cs.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from cs.results where status = 'fail';
  if f > 0 then raise exception '% communications secret check(s) failed', f; end if;
end $$;
