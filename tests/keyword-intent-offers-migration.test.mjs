// Migration 0044: keywords.intent_note, the intent constraint and offers.
// Runs the real migration file in an in-process PostgreSQL (PGlite) over a
// minimal, production-shaped schema. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync("supabase/migrations/0044_keyword_intent_and_offers.sql", "utf8");
const INTENTS = ["navigational", "informational", "commercial", "transactional"];
const TEAM = "00000000-0000-4000-8000-000000000011";
const OUTSIDER = "00000000-0000-4000-8000-000000000012";
const BLUEPRINT = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

// The live shape of what 0044 touches (columns as in database.types.ts;
// enums reduced to text where 0044 does not care).
const BASE = `
  create role anon;
  create role authenticated;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated;
  create table public.clients (id uuid primary key, name text not null);
  create table public.team_members (auth_user_id uuid);
  insert into public.team_members values ('${TEAM}');
  create function public.is_team() returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from team_members where auth_user_id = auth.uid())
  $$;
  create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
  create table public.services (id uuid primary key default gen_random_uuid(), client_id uuid not null references clients(id), name text not null);
  create table public.keywords (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    keyword text not null,
    city text, competition numeric, cpc numeric, volume integer,
    department text not null default 'seo',
    intent text,
    is_active boolean not null default true,
    is_money boolean not null default false,
    is_tracked boolean not null default false,
    last_checked timestamptz,
    priority text not null default 'p2',
    service_id uuid references services(id),
    source text, target_url text,
    created_at timestamptz not null default now()
  );
  grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  -- What Supabase does for every new object in public: 0044 must narrow it.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  insert into clients values ('${BLUEPRINT}', 'Fictional Blueprint Masonry'), ('${OTHER}', 'Fictional Roofing');
`;

async function freshDb(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(BASE);
  return db;
}

const insertKeyword = (db, client, keyword, intent, extra = {}) =>
  db.query(
    `insert into keywords (client_id, keyword, intent, volume, cpc, is_money, is_tracked, target_url)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [client, keyword, intent, extra.volume ?? 90, extra.cpc ?? 4.5, extra.is_money ?? false, extra.is_tracked ?? true, extra.target_url ?? null]
  );

// Every column except the two 0044 may change, as one comparable string.
const snapshot = async (db) =>
  (await db.query(`select to_jsonb(k) - 'intent' - 'intent_note' as row from keywords k order by id`)).rows.map((r) => JSON.stringify(r.row));

// Notes shaped like the blueprint's: punctuation, money, slashes, a dash,
// trailing whitespace, and one that contains an intent word.
const NOTES = [
  "Primary keyword for /block-work",
  "Fold into patios",
  "Money keyword ($18.40 CPC on the near-me variant); no page assigned",
  "TRAP: product shoppers, not builders — section on /patios",
  "Commercial intent, but judge on contracts",
  "Low volume, high intent   ",
];

test("0044 moves every note verbatim, keeps every intent and every other column", async (t) => {
  const db = await freshDb(t);
  const noteIds = [];
  for (const [i, note] of NOTES.entries()) noteIds.push((await insertKeyword(db, BLUEPRINT, `blueprint term ${i}`, note)).rows[0].id);
  const kept = {};
  for (const intent of INTENTS) kept[intent] = (await insertKeyword(db, OTHER, `roof ${intent}`, intent)).rows[0].id;
  const nullId = (await insertKeyword(db, OTHER, "roof unlabelled", null)).rows[0].id;
  const odd = {
    spaced: (await insertKeyword(db, OTHER, "roof spaced", " Commercial ")).rows[0].id,
    upper: (await insertKeyword(db, OTHER, "roof upper", "TRANSACTIONAL")).rows[0].id,
    blank: (await insertKeyword(db, OTHER, "roof blank", "")).rows[0].id,
    spaces: (await insertKeyword(db, OTHER, "roof spaces", "   ")).rows[0].id,
  };
  const before = await snapshot(db);

  await db.exec(migration);

  assert.deepEqual(await snapshot(db), before, "no row added, removed or otherwise changed");
  const byId = async (id) => (await db.query("select intent, intent_note from keywords where id = $1", [id])).rows[0];
  for (const [i, id] of noteIds.entries()) assert.deepEqual(await byId(id), { intent: null, intent_note: NOTES[i] }, "moved verbatim, never guessed");
  for (const intent of INTENTS) assert.deepEqual(await byId(kept[intent]), { intent, intent_note: null });
  assert.deepEqual(await byId(nullId), { intent: null, intent_note: null });
  assert.deepEqual(await byId(odd.spaced), { intent: "commercial", intent_note: null });
  assert.deepEqual(await byId(odd.upper), { intent: "transactional", intent_note: null });
  assert.deepEqual(await byId(odd.blank), { intent: null, intent_note: null });
  assert.deepEqual(await byId(odd.spaces), { intent: null, intent_note: null });
  assert.equal((await db.query("select count(*)::int n from pg_class where relname = 'migration_0044_moved'")).rows[0].n, 0, "scratch table dropped");
});

test("0044 on production-shaped data: 547 rows, 414 intents kept, 55 notes moved, 133 NULL", async (t) => {
  const db = await freshDb(t);
  // Sept 23 measurement: 414 exact intents, 78 NULL, 55 notes on one client.
  await db.exec(`
    insert into keywords (client_id, keyword, intent)
      select '${OTHER}', 'valid ' || g, (array['navigational','informational','commercial','transactional'])[1 + g % 4]
      from generate_series(1, 414) g;
    insert into keywords (client_id, keyword, intent) select '${OTHER}', 'unlabelled ' || g, null from generate_series(1, 78) g;
    insert into keywords (client_id, keyword, intent) select '${BLUEPRINT}', 'note ' || g, 'Primary keyword for /page-' || g from generate_series(1, 55) g;
  `);
  const intentsBefore = (await db.query("select id, intent from keywords where intent in ('navigational','informational','commercial','transactional') order by id")).rows;

  await db.exec(migration);

  const counts = (await db.query(`
    select count(*)::int total,
           count(*) filter (where intent is not null)::int with_intent,
           count(*) filter (where intent is null)::int null_intent,
           count(*) filter (where intent_note is not null)::int with_note,
           count(*) filter (where intent_note is not null and client_id = '${BLUEPRINT}')::int blueprint_notes,
           count(*) filter (where intent_note = 'Primary keyword for /page-' || substring(keyword from 6))::int exact_notes
    from keywords`)).rows[0];
  assert.deepEqual(counts, { total: 547, with_intent: 414, null_intent: 133, with_note: 55, blueprint_notes: 55, exact_notes: 55 });
  assert.deepEqual((await db.query("select id, intent from keywords where intent is not null order by id")).rows, intentsBefore);
});

test("after 0044, intent accepts only the four intents or NULL; notes go to intent_note", async (t) => {
  const db = await freshDb(t);
  await db.exec(migration);
  for (const [raw, stored] of [["informational", "informational"], ["Navigational", "navigational"], ["  commercial\n", "commercial"], ["", null], [null, null]]) {
    const id = (await insertKeyword(db, OTHER, `accept ${String(raw)}`, raw)).rows[0].id;
    assert.equal((await db.query("select intent from keywords where id = $1", [id])).rows[0].intent, stored, `stored ${JSON.stringify(raw)}`);
  }
  for (const bad of ["Primary keyword for /patios", "commercial investigation", "local", "comm"]) {
    await assert.rejects(insertKeyword(db, OTHER, `reject ${bad}`, bad), (e) => e.code === "23514", `refused ${bad}`);
  }
  const id = (await insertKeyword(db, OTHER, "later edited", "commercial")).rows[0].id;
  await assert.rejects(db.query("update keywords set intent = 'Strong intent' where id = $1", [id]), (e) => e.code === "23514");
  await db.query("update keywords set intent_note = 'Strong intent, medium competition' where id = $1", [id]);
  assert.deepEqual((await db.query("select intent, intent_note from keywords where id = $1", [id])).rows[0], { intent: "commercial", intent_note: "Strong intent, medium competition" });
  // A write that doesn't touch intent is unaffected.
  await db.query("update keywords set volume = 500 where id = $1", [id]);
});

test("0044 is all-or-nothing: a tampered move or a second run changes nothing", async (t) => {
  const db = await freshDb(t);
  const noteId = (await insertKeyword(db, BLUEPRINT, "tampered", "Fold into patios")).rows[0].id;
  // Something rewriting notes on the way would lose data; the verify block
  // must refuse and the whole migration must roll back.
  await db.exec(`
    create function mangle() returns trigger language plpgsql as $$
    begin if new.intent_note is not null then new.intent_note := new.intent_note || '!'; end if; return new; end $$;
  `);
  const guarded = migration.replace(
    "update keywords k\nset intent_note",
    "create trigger zz_mangle before update on keywords for each row execute function mangle();\nupdate keywords k\nset intent_note"
  );
  assert.notEqual(guarded, migration, "test hook inserted");
  await assert.rejects(db.exec(guarded), /did not land verbatim/);
  assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_name = 'keywords' and column_name = 'intent_note'")).rows[0].n, 0, "rolled back");
  assert.equal((await db.query("select intent from keywords where id = $1", [noteId])).rows[0].intent, "Fold into patios", "note still where it was");

  await db.exec(migration);
  const after = await db.query("select intent, intent_note from keywords where id = $1", [noteId]);
  await assert.rejects(db.exec(migration), /already exists/);
  assert.deepEqual((await db.query("select intent, intent_note from keywords where id = $1", [noteId])).rows, after.rows, "second run touched nothing");
});

test("offers: exact terms and a source, confirmed only with dates and a confirmer, same-client service, team-only", async (t) => {
  const db = await freshDb(t);
  await db.exec(migration);
  const svc = (await db.query(`insert into services (client_id, name) values ('${OTHER}', 'Roof repair') returning id`)).rows[0].id;
  const otherSvc = (await db.query(`insert into services (client_id, name) values ('${BLUEPRINT}', 'Patios') returning id`)).rows[0].id;
  const offer = (o = {}) => {
    const data = { client_id: OTHER, title: "Fall inspection", terms: "Free roof inspection through October 31", source: "Client email, Sept 20", ...o };
    const cols = Object.keys(data);
    return db.query(`insert into offers (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`, Object.values(data));
  };

  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${TEAM}'`);
  const draft = (await offer({ service_id: svc })).rows[0];
  assert.equal(draft.status, "draft");
  const confirmed = (await offer({ status: "confirmed", starts_on: "2026-10-01", ends_on: "2026-10-31", confirmed_by: "Owner, by email", confirmed_on: "2026-09-21" })).rows[0];
  assert.equal(confirmed.status, "confirmed");

  for (const [patch, why] of [
    [{ terms: "  " }, "blank terms"],
    [{ source: "" }, "no source"],
    [{ title: " " }, "blank title"],
    [{ status: "live" }, "unknown status"],
    [{ starts_on: "2026-10-31", ends_on: "2026-10-01" }, "ends before it starts"],
    [{ status: "confirmed", starts_on: "2026-10-01", ends_on: "2026-10-31" }, "confirmed without a confirmer"],
    [{ status: "confirmed", confirmed_by: "Owner", confirmed_on: "2026-09-21", ends_on: "2026-10-31" }, "confirmed without a start"],
    [{ service_id: otherSvc }, "another client's service"],
  ]) await assert.rejects(offer(patch), (e) => e.code === "23514", why);

  await db.query("update offers set notes = 'Mention the service area' where id = $1", [draft.id]);
  assert.equal((await db.query("select updated_at > created_at as bumped from offers where id = $1", [draft.id])).rows[0].bumped, true, "updated_at moves on edit");

  await db.exec(`set request.jwt.claim.sub = '${OUTSIDER}'`);
  assert.equal((await db.query("select count(*)::int n from offers")).rows[0].n, 0, "a non-team sign-in sees nothing");
  await assert.rejects(offer(), /row-level security/);

  await db.exec("reset role; set role anon");
  await assert.rejects(db.query("select * from offers"), /permission denied/);
  await db.exec("reset role");
  assert.equal((await db.query("select count(*)::int n from offers")).rows[0].n, 2);
});
