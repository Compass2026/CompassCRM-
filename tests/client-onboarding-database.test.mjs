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

test("client onboarding: enrollment, isolation, evidence rules, legacy templates and team-only access", async () => {
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
    // The rollback restores the templates and drops the checklist.
    await db.exec(readFileSync("supabase/rollback/20261029170000_client_onboarding_checklist.down.sql", "utf8"));
    const { rows } = await db.query(`select
      (select count(*)::int from task_templates where title = 'Connect Metricool') metricool,
      (select count(*)::int from task_templates where key in ('brightlocal_lrt','brightlocal_lsg')) brightlocal,
      (select count(*)::int from task_templates where key in ('zernio_connect','bing_webmaster','map_grid_profile')) replaced,
      to_regclass('public.client_onboarding_items') is null dropped,
      (select count(*)::int from pg_trigger where tgname = 'clients_zz_onboarding_checklist') trig`);
    assert.deepEqual(rows[0], { metricool: 1, brightlocal: 2, replaced: 0, dropped: true, trig: 0 });
  } finally {
    await db.close();
  }
});
