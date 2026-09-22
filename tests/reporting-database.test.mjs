import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { METRICS } from "../src/lib/reporting.ts";

const migration = readFileSync("supabase/migrations/0041_client_report_measurements.sql", "utf8");
const teamId = "00000000-0000-4000-8000-000000000011";
const clientA = "00000000-0000-4000-8000-000000000001";
const clientB = "00000000-0000-4000-8000-000000000002";

test("report migration enforces history, input validation, RLS and intake task in PostgreSQL", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  // Minimal dependencies, not a claim of replaying the missing 0036-0038 chain.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    grant usage on schema auth to authenticated, service_role;
    create table public.clients (id uuid primary key);
    create table public.tasks (client_id uuid, title text, owner text, key text, notes text);
    create table public.team_members (auth_user_id uuid);
    insert into public.team_members values ('${teamId}');
    create function public.is_team() returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from team_members where auth_user_id = auth.uid())
    $$;
  `);
  await db.exec(migration);
  await db.exec(`insert into clients values ('${clientA}'), ('${clientB}')`);
  assert.equal((await db.query("select * from tasks where key = 'reporting_baseline'")).rows.length, 2);
  const insert = async (patch = {}) => {
    const data = {
      client_id: clientA, metric: "search_clicks", scope: "example.test web US", source: "Verified export",
      platform: "none", channel: "none", context: "existing_client", report_period: "2026-08-01",
      window_start: "2026-08-01", window_end: "2026-08-31", status: "measured", value: 10,
      evidence: "Fixture export", meaning: "Verified clicks", next_action: "Review queries", ...patch,
    };
    const columns = Object.keys(data);
    return db.query(`insert into report_measurements (${columns.join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")}) returning *`, Object.values(data));
  };
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${teamId}'; set request.jwt.claim.role = 'authenticated'`);
  const first = (await insert({ value: 0, recorded_by: "spoofed", created_at: "2001-01-01", sequence: -1 })).rows[0];
  assert.equal(Number(first.value), 0);
  assert.equal(first.recorded_by, teamId);
  assert.ok(Number(first.sequence) > 0);
  assert.ok(Math.abs(Date.now() - new Date(first.created_at).getTime()) < 60000);
  await assert.rejects(insert({ id: first.id })); // retry cannot duplicate or overwrite
  const backdated = (await insert({ window_start: "2026-08-01", window_end: "2026-08-20", value: 20 })).rows[0];
  assert.ok(Number(backdated.sequence) > Number(first.sequence));

  for (const metric of METRICS) {
    await insert({ metric: metric.key, window_start: metric.kind === "point" ? "2026-08-31" : "2026-08-01", value: metric.key === "reviews_rating" ? 4.5 : 1,
      platform: metric.area === "social" ? "linkedin" : "none", channel: metric.area === "social" ? "organic" : "none" });
  }
  for (const patch of [
    { value: -1 }, { value: "NaN" }, { value: "Infinity" }, { value: 1.1 }, { status: "not_connected", value: 0 },
    { status: "measured", value: null }, { metric: "bad" }, { evidence: "" }, { scope: " " },
    { report_period: "2026-08-02" }, { window_end: "2099-01-01" }, { window_start: "2026-09-01" },
    { metric: "reviews_rating", value: 6, window_start: "2026-08-31" },
    { metric: "social_reach" }, { channel: "paid" }, { metric: "pages_live" },
  ]) await assert.rejects(insert(patch), JSON.stringify(patch));
  await insert({ status: "not_measured", value: null });
  await assert.rejects(db.exec("update report_measurements set value = 99"));
  await assert.rejects(db.exec("delete from report_measurements"));
  await assert.rejects(db.exec("truncate report_measurements"));
  await insert({ client_id: clientB });
  const aRows = (await db.query("select * from report_measurements where client_id = $1", [clientA])).rows;
  assert.ok(aRows.every((r) => r.client_id === clientA));

  await db.exec("set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000012'");
  assert.equal((await db.query("select * from report_measurements")).rows.length, 0);
  await assert.rejects(insert()); // portal/non-team cannot read or append to either client
  await assert.rejects(insert({ client_id: clientB }));
  await db.exec("reset role; set role anon");
  await assert.rejects(db.query("select * from report_measurements"));
  await assert.rejects(insert());
  await db.exec("reset role");
  // Even privileged accidental updates/deletes are blocked by the trigger.
  await assert.rejects(db.exec("update report_measurements set value = 99"), /immutable/);
  await assert.rejects(db.exec("delete from report_measurements"), /immutable/);
  await assert.rejects(db.query("delete from clients where id = $1", [clientA]));
});

test("missing team-access prerequisite aborts migration before creating any objects", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await assert.rejects(db.exec(migration), /team-access prerequisites/);
  await db.exec("rollback");
  assert.equal((await db.query("select to_regclass('public.report_measurements') as name")).rows[0].name, null);
});
