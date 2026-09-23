// Migration 0045: the post record with a human review gate.
// Runs the real migration file in an in-process PostgreSQL (PGlite) over the
// production shape of what it touches, with fictional, production-shaped
// fixtures. Callers are simulated as they reach production:
//   worker     — SQL as postgres (the Supabase connector), session_user postgres
//   human      — PostgREST: session_user authenticator, role authenticated, a team JWT
//   publisher  — PostgREST with the service role key
// PGlite runs as a superuser, so SET SESSION AUTHORIZATION can become
// authenticator exactly as PostgREST's connection is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync("supabase/migrations/0045_social_post_review_gate.sql", "utf8");

const TEAM_AUTH = "00000000-0000-4000-8000-0000000000a1";   // auth.users id
const TEAM_ID = "00000000-0000-4000-8000-0000000000e1";     // team_members id
const TEAM2_AUTH = "00000000-0000-4000-8000-0000000000a2";
const TEAM2_ID = "00000000-0000-4000-8000-0000000000e2";
const STRANGER_AUTH = "00000000-0000-4000-8000-0000000000a9";
const CA = "00000000-0000-4000-8000-0000000000c1";
const CB = "00000000-0000-4000-8000-0000000000c2";
const ID = {
  svcApproved: "00000000-0000-4000-8000-000000000501",
  svcProposed: "00000000-0000-4000-8000-000000000502",
  svcOther: "00000000-0000-4000-8000-000000000503",
  svcSecond: "00000000-0000-4000-8000-000000000504",
  claimConfirmed: "00000000-0000-4000-8000-000000000601",
  claimSourced: "00000000-0000-4000-8000-000000000602",
  claimNoSource: "00000000-0000-4000-8000-000000000603",
  claimUnverified: "00000000-0000-4000-8000-000000000604",
  claimOther: "00000000-0000-4000-8000-000000000605",
  offerStanding: "00000000-0000-4000-8000-000000000701",
  offerDraft: "00000000-0000-4000-8000-000000000702",
  offerWindow: "00000000-0000-4000-8000-000000000703",
  offerOther: "00000000-0000-4000-8000-000000000704",
  keyword: "00000000-0000-4000-8000-000000000801",
  asset: "00000000-0000-4000-8000-000000000901",
  assetOther: "00000000-0000-4000-8000-000000000902",
};

// Production shape (0001, 0009, 0010, 0036, 0043, 0044) of everything 0045
// reads or changes, including Supabase's roles and default privileges.
const BASE = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role authenticator login noinherit;
  grant anon, authenticated, service_role to authenticator;

  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
  create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to public;

  create schema cron;
  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
    insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set command = excluded.command returning jobid $$;

  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create type social_platform as enum ('facebook','instagram','linkedin','x','tiktok');
  create type social_post_status as enum ('idea','drafted','approved','scheduled','published','failed');
  create type social_account_status as enum ('manual_only','connected','expired');
  create type claim_status as enum ('sourced', 'unverified', 'confirmed');
  create type taxonomy_status as enum ('proposed', 'approved', 'retired');
  create type owner_type as enum ('TOM','CLAUDE','CLAUDE_APPROVAL','DELEGATED','WAITING');
  create type task_status as enum ('open','in_progress','blocked','done');

  create table clients (id uuid primary key, name text not null);
  create table team_members (
    id uuid primary key default gen_random_uuid(),
    auth_user_id uuid unique, name text not null, email text not null unique);
  create function is_team() returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from team_members where auth_user_id = auth.uid()) $$;
  create function task_actor() returns uuid language sql stable security definer set search_path = public as $$
    select id from team_members where auth_user_id = auth.uid() $$;
  revoke execute on function task_actor() from public, anon, authenticated;
  create function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

  create table tasks (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    title text not null, owner owner_type not null default 'TOM', status task_status not null default 'open',
    key text, notes text, completed_at timestamptz, assignee_id uuid, created_by uuid,
    created_at timestamptz not null default now(),
    constraint tasks_id_client_key unique (id, client_id));
  create function tasks_stamp() returns trigger language plpgsql security definer set search_path = public as $$
    begin if tg_op = 'INSERT' and auth.uid() is not null then new.created_by := task_actor(); end if; return new; end $$;
  create trigger tasks_aa_stamp before insert or update on tasks for each row execute function tasks_stamp();

  create table services (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    name text not null, status taxonomy_status not null default 'proposed');
  create table keywords (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    keyword text not null, intent text, service_id uuid references services(id) on delete set null);
  create table claims (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    claim text not null, status claim_status not null default 'unverified',
    source text, confirmed_by text, confirmed_on timestamptz, created_at timestamptz not null default now());
  create table offers (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    service_id uuid references services(id) on delete set null,
    title text not null, terms text not null, source text not null,
    starts_on date, ends_on date, status text not null default 'draft',
    confirmed_by text, confirmed_on timestamptz, notes text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create table brand_assets (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    label text not null, storage_path text, url text,
    check (storage_path is not null or url is not null));
  create table social_accounts (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    platform social_platform not null, display_name text,
    status social_account_status not null default 'manual_only');
  create table social_posts (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    social_account_id uuid references social_accounts(id) on delete set null,
    platform social_platform not null,
    copy text, asset_url text, storage_path text, scheduled_at timestamptz,
    status social_post_status not null default 'idea',
    published_url text, external_post_id text, error text, notes text);
  create index social_posts_client_id_status_idx on social_posts (client_id, status);

  do $$ declare t text; begin
    foreach t in array array['clients','team_members','tasks','services','keywords','claims','offers','brand_assets','social_accounts','social_posts'] loop
      execute format('alter table %I enable row level security', t);
      execute format('create policy "team full access" on %I for all to authenticated using ((select is_team())) with check ((select is_team()))', t);
    end loop;
  end $$;
`;

const FIXTURES = `
  insert into clients values ('${CA}', 'Fictional Brothers Masonry'), ('${CB}', 'Fictional Roofing Co');
  insert into team_members (id, auth_user_id, name, email) values
    ('${TEAM_ID}', '${TEAM_AUTH}', 'Tom Example', 'tom@example.test'),
    ('${TEAM2_ID}', '${TEAM2_AUTH}', 'Second Teammate', 'second@example.test');
  insert into services (id, client_id, name, status) values
    ('${ID.svcApproved}', '${CA}', 'Chimney repair', 'approved'),
    ('${ID.svcProposed}', '${CA}', 'Outdoor kitchens', 'proposed'),
    ('${ID.svcOther}', '${CB}', 'Roof replacement', 'approved'),
    ('${ID.svcSecond}', '${CA}', 'Tuckpointing', 'approved');
  insert into keywords (id, client_id, keyword, intent, service_id) values
    ('${ID.keyword}', '${CA}', 'chimney repair springfield mo', 'transactional', '${ID.svcApproved}');
  insert into claims (id, client_id, claim, status, source, confirmed_by, confirmed_on) values
    ('${ID.claimConfirmed}', '${CA}', 'Family owned since 1998', 'confirmed', null, 'Owner, intake call', now()),
    ('${ID.claimSourced}', '${CA}', 'Licensed and insured in Missouri', 'sourced', 'https://a.example.test/about', null, null),
    ('${ID.claimNoSource}', '${CA}', 'Over 2,000 chimneys rebuilt', 'sourced', '  ', null, null),
    ('${ID.claimUnverified}', '${CA}', 'Best masonry in the Ozarks', 'unverified', null, null, null),
    ('${ID.claimOther}', '${CB}', 'GAF certified installer', 'confirmed', null, 'Owner', now());
  insert into offers (id, client_id, service_id, title, terms, source, starts_on, ends_on, status, confirmed_by, confirmed_on) values
    ('${ID.offerStanding}', '${CA}', null, 'Free estimates', 'Free written estimates on any masonry job.', 'Client email Sept 2', null, null, 'confirmed', 'Owner', now()),
    ('${ID.offerDraft}', '${CA}', null, 'Spring special', '10% off tuckpointing', 'Flyer', null, null, 'draft', null, null),
    ('${ID.offerWindow}', '${CA}', '${ID.svcApproved}', 'Fall chimney check', '$99 chimney inspection', 'Website banner', current_date - 5, current_date + 30, 'confirmed', 'Owner', now()),
    ('${ID.offerOther}', '${CB}', null, 'Roof check', 'Free roof check', 'Email', null, null, 'confirmed', 'Owner', now());
  insert into brand_assets (id, client_id, label, storage_path) values
    ('${ID.asset}', '${CA}', 'Chimney rebuild, Nixa', '${CA}/photos/chimney.jpg'),
    ('${ID.assetOther}', '${CB}', 'Roof', '${CB}/photos/roof.jpg');
`;

async function freshDb(t, { fixtures = true } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(BASE);
  if (fixtures) await db.exec(FIXTURES);
  return db;
}

// Built once, then each test starts from a copy of the data directory.
let migratedImage;
async function migrated(t) {
  if (!migratedImage) {
    const seed = new PGlite();
    await seed.exec(BASE);
    await seed.exec(FIXTURES);
    await seed.exec(migration);
    migratedImage = await seed.dumpDataDir("none");
    await seed.close();
  }
  const db = new PGlite({ loadDataDir: migratedImage });
  t.after(() => db.close());
  return db;
}

// ── Callers ──────────────────────────────────────────────────────────────────
const claims = (o) => `select set_config('request.jwt.claims', '${JSON.stringify(o)}', false)`;
async function asWorker(db) {
  await db.exec(`reset role; set session authorization postgres; ${claims({})};`);
}
async function asHuman(db, sub = TEAM_AUTH) {
  await db.exec(`reset role; set session authorization postgres; set session authorization authenticator; set role authenticated; ${claims({ role: "authenticated", sub })};`);
}
async function asPublisher(db) {
  await db.exec(`reset role; set session authorization postgres; set session authorization authenticator; set role service_role; ${claims({ role: "service_role" })};`);
}
// A postgres session pretending to be a signed-in teammate (what the worker
// could do with SQL). session_user stays postgres.
async function asImpersonator(db) {
  await db.exec(`reset role; set session authorization postgres; set role authenticated; ${claims({ role: "authenticated", sub: TEAM_AUTH })};`);
}

async function refused(db, sql, params = [], pattern) {
  let err;
  try {
    await db.query(sql, params);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected refusal: ${sql}`);
  if (pattern) assert.match(err.message, pattern);
  return err;
}

const row = async (db, id) => (await db.query(`select * from social_posts where id = $1`, [id])).rows[0];
const events = async (db, id) =>
  (await db.query(`select kind, actor_kind, actor_id, from_value, to_value, detail from post_events where post_id = $1 order by id`, [id])).rows;

async function draft(db, fields = {}) {
  const f = {
    client_id: CA, platform: "facebook", search_intent: "informational", service_id: ID.svcApproved,
    copy: "Family owned since 1998, we rebuild chimneys across Greene County.", ...fields,
  };
  const cols = Object.keys(f);
  const { rows } = await db.query(
    `insert into social_posts (${cols.join(", ")}) values (${cols.map((c, i) => (c === "platform" ? `$${i + 1}::text::social_platform` : `$${i + 1}`)).join(", ")}) returning id`,
    Object.values(f)
  );
  return rows[0].id;
}
const link = (db, post, claim) => db.query(`insert into post_claims (post_id, claim_id) values ($1, $2)`, [post, claim]);
const setReview = (db, id, status, note = null) =>
  db.query(`update social_posts set review_status = $2, review_note = coalesce($3, review_note) where id = $1`, [id, status, note]);
const setPublish = (db, id, status, extra = "") =>
  db.query(`update social_posts set publish_status = $2 ${extra} where id = $1`, [id, status]);

// Draft → linked confirmed claim → submitted (worker) → approved (human).
async function approvedPost(db, fields = {}) {
  await asWorker(db);
  const id = await draft(db, fields);
  await link(db, id, ID.claimConfirmed);
  await setReview(db, id, "in_review");
  await asHuman(db);
  await setReview(db, id, "approved");
  await asWorker(db);
  return id;
}

// ── The old status column ────────────────────────────────────────────────────
test("0045 refuses to run while social_posts has rows", async (t) => {
  const db = await freshDb(t);
  await db.exec(`insert into social_posts (client_id, platform, status) values ('${CA}', 'facebook', 'published')`);
  await assert.rejects(db.exec(migration), /social_posts has rows/);
});

test("0045 refuses when a view reads social_posts", async (t) => {
  const db = await freshDb(t);
  await db.exec(`create view social_published as select id from social_posts where status = 'published'`);
  await assert.rejects(db.exec(migration), /view reads social_posts/);
});

test("0045 refuses when a function uses the old status", async (t) => {
  const db = await freshDb(t);
  await db.exec(`create function count_published() returns bigint language sql as $$ select count(*) from social_posts where status = 'published' $$`);
  await assert.rejects(db.exec(migration), /function refers/);
});

test("the old status column, its index and its type are gone; google_business is a platform", async (t) => {
  const db = await migrated(t);
  const col = await db.query(`select 1 from information_schema.columns where table_name = 'social_posts' and column_name = 'status'`);
  assert.equal(col.rows.length, 0);
  const typ = await db.query(`select 1 from pg_type where typname = 'social_post_status'`);
  assert.equal(typ.rows.length, 0);
  const idx = await db.query(`select 1 from pg_indexes where indexname = 'social_posts_client_id_status_idx'`);
  assert.equal(idx.rows.length, 0);
  const plat = await db.query(`select enum_range(null::social_platform)::text[] as v`);
  assert.ok(plat.rows[0].v.includes("google_business"));
  const job = await db.query(`select command from cron.job where jobname = 'social-posts-recheck'`);
  assert.match(job.rows[0].command, /recheck_social_posts/);
});

// ── Authorship ───────────────────────────────────────────────────────────────
test("a worker draft is marked worker with no author; a forged author is ignored", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  const id = await draft(db, { author_kind: "human", created_by: TEAM_ID });
  const p = await row(db, id);
  assert.equal(p.author_kind, "worker");
  assert.equal(p.created_by, null);
  assert.equal(p.review_status, "draft");
  assert.equal(p.publish_status, "not_scheduled");
  const ev = await events(db, id);
  assert.deepEqual(ev.map((e) => [e.kind, e.actor_kind, e.actor_id]), [["created", "worker", null]]);
});

test("a human draft records the team_members id, never the Auth UUID", async (t) => {
  const db = await migrated(t);
  await asHuman(db);
  const id = await draft(db, { created_by: TEAM2_ID });
  await asWorker(db);
  const p = await row(db, id);
  assert.equal(p.author_kind, "human");
  assert.equal(p.created_by, TEAM_ID);
  assert.notEqual(p.created_by, TEAM_AUTH);
  const ev = await events(db, id);
  assert.equal(ev[0].actor_id, TEAM_ID);
  assert.equal(ev[0].actor_kind, "team");
});

test("an impersonating postgres session is not a human author", async (t) => {
  const db = await migrated(t);
  await asImpersonator(db);
  const id = await draft(db);
  await asWorker(db);
  assert.equal((await row(db, id)).author_kind, "worker");
});

test("a post cannot be inserted past draft or with workflow fields", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  await refused(db, `insert into social_posts (client_id, platform, search_intent, copy, review_status) values ($1, 'facebook', 'informational', 'x', 'approved')`, [CA], /starts as a draft/);
  await refused(db, `insert into social_posts (client_id, platform, search_intent, copy, reviewed_by) values ($1, 'facebook', 'informational', 'x', $2)`, [CA, TEAM_ID], /set by the workflow/);
  await refused(db, `insert into social_posts (client_id, platform, search_intent, copy, external_post_id) values ($1, 'facebook', 'informational', 'x', 'ext-1')`, [CA], /set by the workflow/);
});

// ── Grounding at submit ──────────────────────────────────────────────────────
test("informational, commercial and transactional posts need a usable claim to leave draft", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  for (const intent of ["informational", "commercial", "transactional"]) {
    const id = await draft(db, { search_intent: intent });
    await refused(db, `update social_posts set review_status = 'in_review' where id = $1`, [id], new RegExp(`${intent} post needs at least one`));
    await link(db, id, ID.claimSourced);
    await setReview(db, id, "in_review");
    assert.equal((await row(db, id)).review_status, "in_review");
  }
});

test("an unverified or source-less claim blocks submission even next to a good one", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  const a = await draft(db);
  await link(db, a, ID.claimConfirmed);
  await link(db, a, ID.claimUnverified);
  await refused(db, `update social_posts set review_status = 'in_review' where id = $1`, [a], /is unverified/);
  const b = await draft(db);
  await link(db, b, ID.claimNoSource);
  await refused(db, `update social_posts set review_status = 'in_review' where id = $1`, [b], /sourced but has no source/);
});

test("a claimless navigational post needs crm_facts_only; other intents cannot set it", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  // Brand-level: no service.
  const nav = await draft(db, { search_intent: "navigational", service_id: null, copy: "Fictional Brothers Masonry — call (417) 555-0100 or visit a.example.test." });
  await refused(db, `update social_posts set review_status = 'in_review' where id = $1`, [nav], /CRM facts only/);
  await db.query(`update social_posts set crm_facts_only = true where id = $1`, [nav]);
  await setReview(db, nav, "in_review");
  assert.equal((await row(db, nav)).review_status, "in_review");
  await refused(db, `insert into social_posts (client_id, platform, search_intent, copy, crm_facts_only) values ($1, 'facebook', 'informational', 'x', true)`, [CA], /crm_facts_navigational/);
  // A navigational post that does link a claim still needs the claim to be usable.
  const nav2 = await draft(db, { search_intent: "navigational" });
  await link(db, nav2, ID.claimUnverified);
  await refused(db, `update social_posts set review_status = 'in_review' where id = $1`, [nav2], /is unverified/);
});

test("offers must be confirmed and current; services approved; offer posts are Business Profile posts", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  await refused(db, `insert into social_posts (client_id, platform, search_intent, copy, post_type, offer_id) values ($1, 'facebook', 'transactional', 'x', 'offer', $2)`, [CA, ID.offerStanding], /gbp_types/);
  await refused(db, `insert into social_posts (client_id, platform, search_intent, copy, post_type) values ($1, 'google_business', 'transactional', 'x', 'offer')`, [CA], /offer_post_has_offer/);
  const draftOffer = await draft(db, { platform: "google_business", post_type: "offer", offer_id: ID.offerDraft, search_intent: "transactional" });
  await link(db, draftOffer, ID.claimConfirmed);
  await refused(db, `update social_posts set review_status = 'in_review' where id = $1`, [draftOffer], /offer is not confirmed/);
  // A standing offer with no dates is fine.
  const standing = await draft(db, { platform: "google_business", post_type: "offer", offer_id: ID.offerStanding, search_intent: "transactional" });
  await link(db, standing, ID.claimConfirmed);
  await setReview(db, standing, "in_review");
  const svc = await draft(db, { service_id: ID.svcProposed });
  await link(db, svc, ID.claimConfirmed);
  await refused(db, `update social_posts set review_status = 'in_review' where id = $1`, [svc], /service is proposed/);
});

// ── Same client ──────────────────────────────────────────────────────────────
test("nothing on a post can belong to another client", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  const id = await draft(db);
  await refused(db, `insert into post_claims (post_id, claim_id) values ($1, $2)`, [id, ID.claimOther], /foreign key/);
  await refused(db, `insert into post_claims (post_id, client_id, claim_id) values ($1, $2, $3)`, [id, CB, ID.claimOther], /foreign key/);
  await refused(db, `insert into post_assets (post_id, brand_asset_id) values ($1, $2)`, [id, ID.assetOther], /foreign key/);
  await refused(db, `update social_posts set service_id = $2 where id = $1`, [id, ID.svcOther], /foreign key/);
  await refused(db, `update social_posts set offer_id = $2 where id = $1`, [id, ID.offerOther], /foreign key/);
  await refused(db, `update social_posts set client_id = $2 where id = $1`, [id, CB], /another client/);
  const otherTask = (await db.query(`insert into tasks (client_id, title) values ($1, 'B task') returning id`, [CB])).rows[0].id;
  await db.query(`update social_posts set review_task_id = $2 where id = $1`, [id, otherTask]);
  assert.equal((await row(db, id)).review_task_id, null, "review_task_id is not caller-settable");
});

// ── Human approval ───────────────────────────────────────────────────────────
test("only a human team member through the API approves; the review task opens and closes", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  const id = await draft(db);
  await link(db, id, ID.claimConfirmed);
  await setReview(db, id, "in_review");
  const task = (await db.query(`select t.* from tasks t join social_posts p on p.review_task_id = t.id where p.id = $1`, [id])).rows[0];
  assert.equal(task.key, "post_review");
  assert.equal(task.owner, "CLAUDE_APPROVAL", "the hold lane: drafted, a person decides");
  assert.equal(task.status, "open");
  assert.equal(task.assignee_id, null);
  assert.equal(task.client_id, CA);
  assert.match(task.notes, new RegExp(id));

  await refused(db, `update social_posts set review_status = 'approved' where id = $1`, [id], /Only a signed-in Compass team member/);
  await asPublisher(db);
  await refused(db, `update social_posts set review_status = 'approved' where id = $1`, [id], /Only a signed-in Compass team member/);
  await asImpersonator(db);
  await refused(db, `update social_posts set review_status = 'approved' where id = $1`, [id], /Only a signed-in Compass team member/);
  await asHuman(db, STRANGER_AUTH);
  const r = await db.query(`update social_posts set review_status = 'approved' where id = $1`, [id]);
  assert.equal(r.affectedRows, 0, "a non-team sign-in sees no post");

  await asHuman(db, TEAM2_AUTH);
  await setReview(db, id, "approved");
  await asWorker(db);
  const p = await row(db, id);
  assert.equal(p.review_status, "approved");
  assert.equal(p.reviewed_by, TEAM2_ID);
  assert.ok(p.reviewed_at);
  assert.equal(p.approved_snapshot.copy, p.copy);
  assert.deepEqual(p.approved_snapshot.claims.map((c) => c.claim), ["Family owned since 1998"]);
  assert.match(p.approved_hash, /^[0-9a-f]{64}$/);
  const closed = (await db.query(`select status, completed_at from tasks where id = $1`, [task.id])).rows[0];
  assert.equal(closed.status, "done");
  assert.ok(closed.completed_at);
  const ev = await events(db, id);
  assert.deepEqual(ev.map((e) => e.kind), ["created", "claim_linked", "submitted", "approved"]);
  assert.equal(ev.at(-1).actor_id, TEAM2_ID);
  assert.equal(ev.at(-1).actor_kind, "team");
});

test("a person may approve their own human-authored draft", async (t) => {
  const db = await migrated(t);
  await asHuman(db);
  const id = await draft(db);
  await link(db, id, ID.claimConfirmed);
  await setReview(db, id, "in_review");
  await setReview(db, id, "approved");
  await asWorker(db);
  const p = await row(db, id);
  assert.equal(p.created_by, TEAM_ID);
  assert.equal(p.reviewed_by, TEAM_ID);
});

test("the approval re-checks grounding: a claim unverified during review blocks approval", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  const id = await draft(db);
  await link(db, id, ID.claimSourced);
  await setReview(db, id, "in_review");
  await db.query(`update claims set status = 'unverified' where id = $1`, [ID.claimSourced]);
  await asHuman(db);
  await refused(db, `update social_posts set review_status = 'approved' where id = $1`, [id], /is unverified/);
  await asWorker(db);
  const ev = await events(db, id);
  assert.equal(ev.at(-1).kind, "grounding_lapsed", "the in-review post records the lapse");
  assert.equal((await row(db, id)).review_status, "in_review");
});

test("rejection is human-only and needs a reason; the worker revises and resubmits", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  const id = await draft(db);
  await link(db, id, ID.claimConfirmed);
  await setReview(db, id, "in_review");
  await refused(db, `update social_posts set review_status = 'rejected', review_note = 'no' where id = $1`, [id], /Only a signed-in Compass team member can reject/);
  await asHuman(db);
  await refused(db, `update social_posts set review_status = 'rejected' where id = $1`, [id], /Say why/);
  await setReview(db, id, "rejected", "Too salesy; lead with the rebuild photos.");
  await asWorker(db);
  let p = await row(db, id);
  assert.equal(p.reviewed_by, TEAM_ID);
  await refused(db, `update social_posts set copy = 'new' where id = $1`, [id], /frozen/);
  await setReview(db, id, "draft");
  await db.query(`update social_posts set copy = 'We rebuilt this Nixa chimney in two days. Family owned since 1998.' where id = $1`, [id]);
  p = await row(db, id);
  assert.equal(p.review_note, "Too salesy; lead with the rebuild photos.", "the reviser still sees why");
  await setReview(db, id, "in_review");
  const tasks = (await db.query(`select status from tasks where key = 'post_review' order by created_at`)).rows;
  assert.deepEqual(tasks.map((x) => x.status), ["done", "open"]);
  assert.deepEqual((await events(db, id)).map((e) => e.kind),
    ["created", "claim_linked", "submitted", "rejected", "revised", "edited", "submitted"]);
});

test("the worker may withdraw; transitions outside the workflow are refused", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  const id = await draft(db);
  await refused(db, `update social_posts set review_status = 'approved' where id = $1`, [id], /cannot go from draft to approved/);
  await link(db, id, ID.claimConfirmed);
  await setReview(db, id, "in_review");
  const taskId = (await row(db, id)).review_task_id;
  await setReview(db, id, "draft");
  const p = await row(db, id);
  assert.equal(p.review_task_id, null);
  assert.equal((await db.query(`select status from tasks where id = $1`, [taskId])).rows[0].status, "done");
});

// ── Frozen content ───────────────────────────────────────────────────────────
test("content, claims and assets are frozen once submitted", async (t) => {
  const db = await migrated(t);
  const id = await approvedPost(db);
  for (const [col, val] of [["copy", "changed"], ["cta_url", "https://evil.example"], ["search_intent", "commercial"], ["offer_id", ID.offerStanding]]) {
    await refused(db, `update social_posts set ${col} = $2 where id = $1`, [id, val], /frozen/);
  }
  await refused(db, `insert into post_claims (post_id, claim_id) values ($1, $2)`, [id, ID.claimSourced], /frozen/);
  await refused(db, `delete from post_claims where post_id = $1`, [id], /frozen/);
  await refused(db, `insert into post_assets (post_id, brand_asset_id) values ($1, $2)`, [id, ID.asset], /frozen/);
  await refused(db, `update post_claims set claim_id = $2 where post_id = $1`, [id, ID.claimSourced], /not edited/);
  // Notes and the keyword link are not content.
  await db.query(`update social_posts set notes = 'shoot a new photo', keyword_id = $2 where id = $1`, [id, ID.keyword]);
  assert.equal((await row(db, id)).review_status, "approved");
});

test("an approved post is reopened only by a human, which clears the approval", async (t) => {
  const db = await migrated(t);
  const id = await approvedPost(db);
  await db.query(`update social_posts set scheduled_at = now() + interval '2 days' where id = $1`, [id]);
  await setPublish(db, id, "scheduled");
  await refused(db, `update social_posts set review_status = 'draft' where id = $1`, [id], /Only a signed-in Compass team member can reopen/);
  await asHuman(db);
  await setReview(db, id, "draft");
  await asWorker(db);
  const p = await row(db, id);
  assert.equal(p.review_status, "draft");
  assert.equal(p.publish_status, "not_scheduled");
  assert.equal(p.reviewed_by, null);
  assert.equal(p.approved_hash, null);
  assert.equal((await events(db, id)).at(-1).kind, "reopened");
});

// ── Execution needs an approval ──────────────────────────────────────────────
test("nothing is scheduled without an approval; scheduling never touches the approval", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  const d = await draft(db, { scheduled_at: new Date(Date.now() + 86400000).toISOString() });
  await refused(db, `update social_posts set publish_status = 'scheduled' where id = $1`, [d], /approved post can be scheduled|execution_needs_approval/);
  const id = await approvedPost(db);
  const before = await row(db, id);
  await refused(db, `update social_posts set publish_status = 'scheduled' where id = $1`, [id], /scheduled_has_time/);
  await db.query(`update social_posts set scheduled_at = now() + interval '1 day' where id = $1`, [id]);
  await setPublish(db, id, "scheduled");
  await refused(db, `update social_posts set publish_status = 'not_scheduled', review_status = 'draft' where id = $1`, [id], /separately/);
  // Review columns ride along untouched on a publishing change.
  await db.query(`update social_posts set publish_status = 'not_scheduled', reviewed_by = $2, approved_hash = 'x' where id = $1`, [id, TEAM2_ID]);
  await setPublish(db, id, "scheduled");
  const after = await row(db, id);
  for (const k of ["review_status", "reviewed_by", "reviewed_at", "approved_hash"]) assert.deepEqual(after[k], before[k], k);
});

test("only the publisher publishes; it re-validates, counts attempts and records results", async (t) => {
  const db = await migrated(t);
  const id = await approvedPost(db, { platform: "google_business", search_intent: "commercial" });
  await db.query(`update social_posts set scheduled_at = now() where id = $1`, [id]);
  await setPublish(db, id, "scheduled");
  const approval = await row(db, id);

  await refused(db, `update social_posts set publish_status = 'publishing' where id = $1`, [id], /Only the publisher/);
  await asHuman(db);
  await refused(db, `update social_posts set publish_status = 'publishing' where id = $1`, [id], /Only the publisher/);
  await refused(db, `update social_posts set external_post_id = 'x' where id = $1`, [id], /recorded by the publisher/);

  await asPublisher(db);
  await setPublish(db, id, "publishing");
  await refused(db, `update social_posts set publish_status = 'failed' where id = $1`, [id], /failed_explained/);
  await setPublish(db, id, "failed", `, error = 'Google: 503 backend error'`);
  await asWorker(db);
  await setPublish(db, id, "scheduled"); // retry
  let p = await row(db, id);
  assert.equal(p.publish_attempts, 1);
  assert.equal(p.error, "Google: 503 backend error", "the last error stays on record through the retry");
  await asPublisher(db);
  await setPublish(db, id, "publishing");
  await refused(db, `update social_posts set publish_status = 'published' where id = $1`, [id], /published_complete/);
  await setPublish(db, id, "published", `, external_post_id = 'accounts/1/locations/2/localPosts/3', published_url = 'https://posts.example.test/3', published_at = now()`);
  await asWorker(db);
  p = await row(db, id);
  assert.equal(p.publish_status, "published");
  assert.equal(p.publish_attempts, 2);
  assert.equal(p.error, null);
  for (const k of ["review_status", "reviewed_by", "reviewed_at", "approved_hash", "approved_snapshot"]) {
    assert.deepEqual(p[k], approval[k], `${k} survived publishing and the retry`);
  }
  assert.equal(p.publish_key, approval.publish_key);
  assert.deepEqual((await events(db, id)).slice(-6).map((e) => [e.kind, e.actor_kind]), [
    ["scheduled", "worker"], ["publishing", "publisher"], ["failed", "publisher"],
    ["retried", "worker"], ["publishing", "publisher"], ["published", "publisher"],
  ]);
  // A published post is on record for good.
  await refused(db, `update social_posts set scheduled_at = now() where id = $1`, [id], /no longer change/);
  await refused(db, `delete from social_posts where id = $1`, [id], /stays on record/);
  await asHuman(db);
  await refused(db, `update social_posts set review_status = 'draft' where id = $1`, [id], /no longer be reopened/);
  // The same external post cannot be recorded twice.
  await asWorker(db);
  const second = await approvedPost(db, { platform: "google_business", search_intent: "commercial" });
  await db.query(`update social_posts set scheduled_at = now() where id = $1`, [second]);
  await setPublish(db, second, "scheduled");
  await asPublisher(db);
  await setPublish(db, second, "publishing");
  await refused(db, `update social_posts set publish_status = 'published', external_post_id = 'accounts/1/locations/2/localPosts/3', published_url = 'u', published_at = now() where id = $1`, [second], /duplicate key/);
});

test("publishing refuses a post whose support lapsed without anyone noticing", async (t) => {
  const db = await migrated(t);
  const id = await approvedPost(db, { platform: "google_business", post_type: "offer", offer_id: ID.offerWindow, search_intent: "transactional" });
  await db.query(`update social_posts set scheduled_at = now() where id = $1`, [id]);
  await setPublish(db, id, "scheduled");
  // Simulate time passing: the offer ends with no update event.
  await db.exec(`alter table offers disable trigger offers_zz_recheck_posts; update offers set ends_on = current_date - 1 where id = '${ID.offerWindow}'; alter table offers enable trigger offers_zz_recheck_posts;`);
  await asPublisher(db);
  await refused(db, `update social_posts set publish_status = 'publishing' where id = $1`, [id], /changed since it was approved|offer ended/);
  // The daily job sends it back to review.
  await asWorker(db);
  const n = (await db.query(`select recheck_social_posts() as n`)).rows[0].n;
  assert.equal(n, 1);
  const p = await row(db, id);
  assert.equal(p.review_status, "in_review");
  assert.equal(p.publish_status, "not_scheduled");
});

// ── Lapse ────────────────────────────────────────────────────────────────────
test("a claim going unverified sends an approved, scheduled post back to review with a new task", async (t) => {
  const db = await migrated(t);
  const id = await approvedPost(db);
  await db.query(`update social_posts set scheduled_at = now() + interval '3 days' where id = $1`, [id]);
  await setPublish(db, id, "scheduled");
  await asHuman(db);
  await db.query(`update claims set status = 'unverified' where id = $1`, [ID.claimConfirmed]);
  await asWorker(db);
  const p = await row(db, id);
  assert.equal(p.review_status, "in_review");
  assert.equal(p.publish_status, "not_scheduled");
  assert.equal(p.reviewed_by, null);
  assert.equal(p.approved_hash, null);
  const task = (await db.query(`select status, notes from tasks where id = $1`, [p.review_task_id])).rows[0];
  assert.equal(task.status, "open");
  assert.match(task.notes, /Sent back to review/);
  const last = (await events(db, id)).at(-1);
  assert.equal(last.kind, "grounding_lapsed");
  assert.equal(last.actor_kind, "system");
  assert.match(JSON.stringify(last.detail.problems), /unverified/);
  assert.equal(last.detail.unscheduled_from, "scheduled");
});

test("editing a linked claim's text, retiring the offer or service, or deleting a claim all lapse", async (t) => {
  const db = await migrated(t);
  const a = await approvedPost(db);
  await db.query(`update claims set claim = 'Family owned since 1988' where id = $1`, [ID.claimConfirmed]);
  assert.equal((await row(db, a)).review_status, "in_review");
  assert.match(JSON.stringify((await events(db, a)).at(-1).detail.problems), /changed since it was approved/);

  const b = await approvedPost(db, { platform: "google_business", post_type: "offer", offer_id: ID.offerStanding, search_intent: "transactional" });
  await db.query(`update offers set status = 'retired' where id = $1`, [ID.offerStanding]);
  assert.equal((await row(db, b)).review_status, "in_review");

  const c = await approvedPost(db, { service_id: ID.svcApproved });
  await db.query(`update services set status = 'retired' where id = $1`, [ID.svcApproved]);
  assert.equal((await row(db, c)).review_status, "in_review");

  await asWorker(db);
  const d = await draft(db, { service_id: ID.svcSecond });
  await link(db, d, ID.claimSourced);
  await setReview(db, d, "in_review");
  await asHuman(db);
  await setReview(db, d, "approved");
  await asWorker(db);
  await db.query(`delete from claims where id = $1`, [ID.claimSourced]);
  const pd = await row(db, d);
  assert.equal(pd.review_status, "in_review");
  assert.deepEqual((await events(db, d)).slice(-2).map((e) => e.kind), ["claim_unlinked", "grounding_lapsed"]);
});

test("a published post is never moved by a lapse; it records the event", async (t) => {
  const db = await migrated(t);
  const id = await approvedPost(db);
  await db.query(`update social_posts set scheduled_at = now() where id = $1`, [id]);
  await setPublish(db, id, "scheduled");
  await asPublisher(db);
  await setPublish(db, id, "publishing");
  await setPublish(db, id, "published", `, external_post_id = 'fb-1', published_url = 'https://facebook.example/1', published_at = now()`);
  await asWorker(db);
  await db.query(`update claims set status = 'unverified' where id = $1`, [ID.claimConfirmed]);
  const p = await row(db, id);
  assert.equal(p.review_status, "approved");
  assert.equal(p.publish_status, "published");
  const last = (await events(db, id)).at(-1);
  assert.equal(last.kind, "grounding_lapsed");
  assert.equal(last.detail.publish_status, "published");
});

test("approved → in_review by hand is refused when nothing changed", async (t) => {
  const db = await migrated(t);
  const id = await approvedPost(db);
  await refused(db, `update social_posts set review_status = 'in_review' where id = $1`, [id], /Nothing the approval stood on has changed/);
});

// ── Delete ───────────────────────────────────────────────────────────────────
test("drafts can be deleted; submitted, approved or published posts stay on record", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  const d = await draft(db);
  await link(db, d, ID.claimConfirmed);
  await db.query(`delete from social_posts where id = $1`, [d]);
  assert.equal((await db.query(`select count(*)::int n from post_claims where post_id = $1`, [d])).rows[0].n, 0);
  const a = await approvedPost(db);
  await refused(db, `delete from social_posts where id = $1`, [a], /stays on record/);
  // Deleting the client is refused while an approved post is on record.
  await refused(db, `delete from clients where id = $1`, [CA], /stays on record/);
});

test("a linked service or offer cannot be deleted (retire it instead)", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  await draft(db, { service_id: ID.svcApproved, platform: "google_business", post_type: "offer", offer_id: ID.offerStanding, search_intent: "transactional" });
  await refused(db, `delete from services where id = $1`, [ID.svcApproved], /foreign key/);
  await refused(db, `delete from offers where id = $1`, [ID.offerStanding], /foreign key/);
});

// ── Access ───────────────────────────────────────────────────────────────────
test("team-only access; history is read-only; internal functions are not callable", async (t) => {
  const db = await migrated(t);
  const id = await approvedPost(db);
  await db.exec(`reset role; set session authorization postgres; set role anon; ${claims({ role: "anon" })};`);
  await refused(db, `select * from social_posts`, [], /permission denied/);
  await refused(db, `select * from post_events`, [], /permission denied/);
  await asHuman(db, STRANGER_AUTH);
  assert.equal((await db.query(`select count(*)::int n from social_posts`)).rows[0].n, 0);
  assert.equal((await db.query(`select count(*)::int n from post_events`)).rows[0].n, 0);
  await refused(db, `select social_post_readiness($1)`, [id], /Only the Compass team/);
  await asHuman(db);
  assert.ok((await db.query(`select count(*)::int n from post_events`)).rows[0].n > 0);
  await refused(db, `insert into post_events (post_id, client_id, actor_kind, kind) values ($1, $2, 'team', 'approved')`, [id, CA], /permission denied/);
  await refused(db, `delete from post_events`, [], /permission denied/);
  await refused(db, `select recheck_social_posts()`, [], /permission denied/);
  await refused(db, `select post_caller_is_human()`, [], /permission denied/);
  const ready = (await db.query(`select social_post_readiness($1) as r`, [id])).rows[0].r;
  assert.deepEqual(ready, []);
});

test("social_post_readiness lists what blocks a draft", async (t) => {
  const db = await migrated(t);
  await asHuman(db);
  const id = await draft(db, { copy: "  " });
  const r = (await db.query(`select social_post_readiness($1) as r`, [id])).rows[0].r;
  assert.ok(r.some((m) => /no copy/.test(m)));
  assert.ok(r.some((m) => /informational post needs/.test(m)));
});

// ── Topic architecture ───────────────────────────────────────────────────────
test("a standard non-navigational post needs an approved service; navigational may be brand-level; offers may be business-wide", async (t) => {
  const db = await migrated(t);
  await asWorker(db);
  for (const intent of ["informational", "commercial", "transactional"]) {
    const id = await draft(db, { search_intent: intent, service_id: null });
    await link(db, id, ID.claimConfirmed);
    await refused(db, `update social_posts set review_status = 'in_review' where id = $1`, [id], new RegExp(`${intent} post needs an approved service`));
  }
  const brand = await draft(db, { search_intent: "navigational", service_id: null, crm_facts_only: true });
  await setReview(db, brand, "in_review");
  // A business-wide offer: no service, still submittable.
  const offer = await draft(db, { platform: "google_business", post_type: "offer", offer_id: ID.offerStanding, search_intent: "transactional", service_id: null });
  await link(db, offer, ID.claimConfirmed);
  await setReview(db, offer, "in_review");
  // keyword_id stays optional either way.
  assert.equal((await row(db, offer)).keyword_id, null);
  // Event posts are not supported in 0045.
  await refused(db, `insert into social_posts (client_id, platform, post_type, search_intent, copy) values ($1, 'google_business', 'event', 'informational', 'x')`, [CA], /post_type_known/);
});

// ── Media ────────────────────────────────────────────────────────────────────
test("post_assets is the only media model: legacy columns are gone, assets are in the snapshot and frozen", async (t) => {
  const db = await migrated(t);
  const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'social_posts' and column_name in ('asset_url', 'storage_path')`)).rows;
  assert.deepEqual(cols, []);
  await asWorker(db);
  const id = await draft(db);
  await link(db, id, ID.claimConfirmed);
  await db.query(`insert into post_assets (post_id, brand_asset_id, sort_order, content_hash) values ($1, $2, 1, 'sha256:abc')`, [id, ID.asset]);
  await setReview(db, id, "in_review");
  await asHuman(db);
  await setReview(db, id, "approved");
  await asWorker(db);
  const snap = (await row(db, id)).approved_snapshot;
  assert.deepEqual(snap.assets.map((a) => [a.id, a.sort_order, a.content_hash, a.storage_path]), [[ID.asset, 1, "sha256:abc", `${CA}/photos/chimney.jpg`]]);
  assert.ok(!("asset_url" in snap) && !("storage_path" in snap));
  await refused(db, `delete from post_assets where post_id = $1`, [id], /frozen/);
  // The asset file changing sends the post back to review.
  await db.query(`update brand_assets set storage_path = $2 where id = $1`, [ID.asset, `${CA}/photos/chimney-v2.jpg`]);
  assert.equal((await row(db, id)).review_status, "in_review");
});

// ── Manual publishing ────────────────────────────────────────────────────────
async function approvedSocial(db, fields = {}) {
  return approvedPost(db, { platform: "instagram", ...fields });
}
const markPublished = (db, id, extra = `, published_at = now() - interval '1 minute', published_url = 'https://instagram.example/p/1'`) =>
  db.query(`update social_posts set publish_status = 'published' ${extra} where id = $1`, [id]);

test("a person marks an approved social post published by hand; the approval is untouched", async (t) => {
  const db = await migrated(t);
  const id = await approvedSocial(db);
  const before = await row(db, id);
  await asHuman(db, TEAM2_AUTH);
  await refused(db, `update social_posts set publish_status = 'published', published_url = 'https://instagram.example/p/1' where id = $1`, [id], /where and when/);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now() where id = $1`, [id], /where and when/);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now() + interval '1 day', published_url = 'https://instagram.example/p/1' where id = $1`, [id], /in the future/);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now(), published_url = 'http://instagram.example/p/1' where id = $1`, [id], /https/);
  await markPublished(db, id);
  await asWorker(db);
  const p = await row(db, id);
  assert.equal(p.publish_status, "published");
  assert.equal(p.external_post_id, null, "no external id needed for a hand-published social post");
  assert.equal(p.published_url, "https://instagram.example/p/1");
  assert.equal(p.publish_attempts, 0);
  for (const k of ["review_status", "reviewed_by", "reviewed_at", "approved_hash", "approved_snapshot"]) assert.deepEqual(p[k], before[k], k);
  const ev = (await events(db, id)).at(-1);
  assert.equal(ev.kind, "published");
  assert.equal(ev.actor_kind, "team");
  assert.equal(ev.actor_id, TEAM2_ID);
  assert.equal(ev.detail.manual, true);
  // And it is on record for good.
  await refused(db, `delete from social_posts where id = $1`, [id], /stays on record/);
});

test("manual publication works from scheduled and failed too, and never for the wrong caller or state", async (t) => {
  const db = await migrated(t);
  const scheduled = await approvedSocial(db, { platform: "linkedin" });
  await db.query(`update social_posts set scheduled_at = now() where id = $1`, [scheduled]);
  await setPublish(db, scheduled, "scheduled");
  // The worker, the publisher's key and an impersonating postgres session cannot.
  await refused(db, `update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://linkedin.example/1' where id = $1`, [scheduled], /Only a signed-in Compass team member can mark/);
  await asPublisher(db);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://linkedin.example/1' where id = $1`, [scheduled], /Only a signed-in Compass team member can mark/);
  await asImpersonator(db);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://linkedin.example/1' where id = $1`, [scheduled], /Only a signed-in Compass team member can mark/);
  await asHuman(db);
  await markPublished(db, scheduled, `, published_at = now(), published_url = 'https://linkedin.example/1'`);
  await asWorker(db);
  assert.equal((await row(db, scheduled)).publish_status, "published");

  // A draft or an in-review post cannot be marked published.
  const d = await draft(db, { platform: "x" });
  await asHuman(db);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://x.example/1' where id = $1`, [d], /not approved|execution_needs_approval/);
  // Not from publishing: that is the publisher's.
  await asWorker(db);
  const pub = await approvedSocial(db, { platform: "facebook" });
  await db.query(`update social_posts set scheduled_at = now() where id = $1`, [pub]);
  await setPublish(db, pub, "scheduled");
  await asPublisher(db);
  await setPublish(db, pub, "publishing");
  await asHuman(db);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://facebook.example/1' where id = $1`, [pub], /Only the publisher records the result/);
});

test("a Business Profile post is never marked published by hand", async (t) => {
  const db = await migrated(t);
  const id = await approvedPost(db, { platform: "google_business", search_intent: "commercial" });
  await asHuman(db);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://business.google.example/1', external_post_id = 'x' where id = $1`, [id], /published by the publisher, not by hand/);
  assert.equal((await row(db, id)).publish_status, "not_scheduled");
});

test("manual publication re-checks the approval hash and the grounding", async (t) => {
  const db = await migrated(t);
  // Grounding: the offer ends with nobody noticing (lapse trigger off).
  const a = await approvedSocial(db, { platform: "facebook", search_intent: "transactional" });
  await db.exec(`alter table offers disable trigger offers_zz_recheck_posts;`);
  await db.exec(`alter table claims disable trigger claims_zz_recheck_posts; update claims set status = 'unverified' where id = '${ID.claimConfirmed}'; alter table claims enable trigger claims_zz_recheck_posts;`);
  await asHuman(db);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://facebook.example/1' where id = $1`, [a], /is unverified|changed since it was approved/);
  await asWorker(db);
  await db.exec(`update claims set status = 'confirmed' where id = '${ID.claimConfirmed}';`);
  // Hash: claim text edited with the lapse trigger off.
  const b = await approvedSocial(db, { platform: "facebook", service_id: ID.svcSecond });
  await db.exec(`alter table claims disable trigger claims_zz_recheck_posts; update claims set claim = 'Family owned since 1988' where id = '${ID.claimConfirmed}'; alter table claims enable trigger claims_zz_recheck_posts;`);
  await asHuman(db);
  await refused(db, `update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://facebook.example/2' where id = $1`, [b], /changed since it was approved/);
});
