// Replays every migration into PGlite (with the replay hooks around
// 20261029170000) and runs the New Client Onboarding database suite
// (supabase/tests/sandbox/client_onboarding.test.sql, also run natively by
// scripts/test-portal-sandbox.sh). Fictional fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const HOOKS = "supabase/tests/sandbox/replay";
const ONLY = new Set(["20261029170000"]);

test("client onboarding: coverage gaps, prerequisites, exact matching, isolation, evidence rules, templates, deferred labels, rollback", async () => {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  try {
    await db.exec("create role supabase_admin superuser login");
    await db.exec(
      readFileSync("supabase/tests/sandbox/bootstrap.sql", "utf8")
        .replace("create role postgres login nosuperuser bypassrls createrole createdb;", "")
        .replaceAll("database sandbox", "database postgres"),
    );
    await db.exec("set search_path=public,extensions");
    for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
      const num = file.split("_")[0];
      const hook = (when) => `${HOOKS}/${num}.${when}.sql`;
      if (ONLY.has(num) && existsSync(hook("before"))) await db.exec(readFileSync(hook("before"), "utf8"));
      await db.exec("begin;" + readFileSync(`supabase/migrations/${file}`, "utf8").replace(/^create extension if not exists pg_(cron|net);/gm, "") + ";commit;");
      if (ONLY.has(num) && existsSync(hook("after"))) await db.exec(readFileSync(hook("after"), "utf8"));
    }
    await db.exec(readFileSync("supabase/tests/sandbox/client_onboarding.test.sql", "utf8"));
    // The deferred legacy-label script: refuses without the reviewed count, labels open tasks only.
    await db.exec(`insert into clients (id, name) values ('0b900000-0000-4000-b000-00000000000a', 'Deferred Labels Sample (fictional)');
      insert into tasks (id, client_id, title, owner, status, key, completed_at, notes) values
        ('0b900000-0000-4000-c000-000000000001', '0b900000-0000-4000-b000-00000000000a', 'BrightLocal Local Rank Tracker report (sample)', 'TOM', 'open', 'brightlocal_lrt', null, null),
        ('0b900000-0000-4000-c000-000000000002', '0b900000-0000-4000-b000-00000000000a', 'BrightLocal Local Search Grid report (sample)', 'TOM', 'done', 'brightlocal_lsg', '2026-09-21 15:00:00+00', 'LSG 1'),
        ('0b900000-0000-4000-c000-000000000003', '0b900000-0000-4000-b000-00000000000a', 'Connect Metricool', 'TOM', 'open', null, null, null),
        ('0b900000-0000-4000-c000-000000000004', '0b900000-0000-4000-b000-00000000000a', 'Connect Metricool', 'TOM', 'done', null, '2026-09-20 15:00:00+00', 'Connected')`);
    const deferred = readFileSync("supabase/deferred/20261029_legacy_task_labels.sql", "utf8");
    const open = (await db.query(`select count(*)::int n from tasks where status <> 'done' and title not like '[Legacy%' and (key in ('brightlocal_lrt','brightlocal_lsg') or title = 'Connect Metricool')`)).rows[0].n;
    assert.equal(open, 2);
    await assert.rejects(db.exec("begin;" + deferred + ";commit;"), /expected no count open tasks, found 2/);
    await db.exec("rollback");
    await assert.rejects(db.exec("begin; set local compass.expected_legacy_tasks = '3';" + deferred + ";commit;"), /expected 3 open tasks, found 2/);
    await db.exec("rollback");
    await db.exec("begin; set local compass.expected_legacy_tasks = '2';" + deferred + ";commit;");
    const labelled = (await db.query(`select id, title, status, completed_at, notes from tasks where id::text like '0b900000-0000-4000-c000-%' order by id`)).rows;
    assert.deepEqual(labelled.map((t) => [t.title.slice(0, 24), t.status, t.notes?.slice(0, 11) ?? null]), [
      ["[Legacy — do not buy] Br", "open", "Oct 29 2026"],
      ["BrightLocal Local Search", "done", "LSG 1"],
      ["[Legacy] Connect Metrico", "open", "Oct 29 2026"],
      ["Connect Metricool", "done", "Connected"],
    ]);
    // The rollback restores the templates and drops the checklist.
    await db.exec(readFileSync("supabase/rollback/20261029170000_client_onboarding_checklist.down.sql", "utf8"));
    const { rows } = await db.query(`select
      (select count(*)::int from task_templates where title = 'Connect Metricool') metricool,
      (select count(*)::int from task_templates where key in ('brightlocal_lrt','brightlocal_lsg')) brightlocal,
      (select count(*)::int from task_templates where key in ('zernio_connect','bing_webmaster','map_grid_profile')) replaced,
      to_regclass('public.client_onboarding_items') is null dropped,
      (select count(*)::int from pg_trigger where tgname like '%zz_onboarding_checklist') trig,
      (select count(*)::int from tasks where title like '[Legacy%') legacy`);
    assert.deepEqual(rows[0], { metricool: 1, brightlocal: 2, replaced: 0, dropped: true, trig: 0, legacy: 0 });
  } finally {
    await db.close();
  }
});
