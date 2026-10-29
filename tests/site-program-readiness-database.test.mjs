// Replays every migration into PGlite and runs the site-program readiness
// suite (supabase/tests/sandbox/site_program_readiness.test.sql, also run
// natively by scripts/test-portal-sandbox.sh). Its \ir lines (the place seed,
// the down script, the migration re-applied) are inlined here. Fictional
// fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const SUITE = "supabase/tests/sandbox/site_program_readiness.test.sql";

test("site_program_readiness: gates, place detection, isolation, access, no writes, rollback", async () => {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  try {
    await db.exec("create role supabase_admin superuser login");
    await db.exec(
      readFileSync("supabase/tests/sandbox/bootstrap.sql", "utf8")
        .replace("create role postgres login nosuperuser bypassrls createrole createdb;", "")
        .replaceAll("database sandbox", "database postgres"),
    );
    await db.exec("set search_path=public,extensions");
    for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
      await db.exec("begin;" + readFileSync(`supabase/migrations/${file}`, "utf8").replace(/^create extension if not exists pg_(cron|net);/gm, "") + ";commit;");
    const notices = [];
    const suite = readFileSync(SUITE, "utf8").replace(/^\\ir (.+)$/gm, (_, rel) => readFileSync(path.join(path.dirname(SUITE), rel), "utf8"));
    await db.exec(suite, { onNotice: (n) => notices.push(n.message) });
    const ok = notices.filter((m) => m.startsWith("ok "));
    for (const label of ["U1", "B1", "B4", "B5", "B8", "C1", "M2", "M3", "E1", "X2", "X3", "W1", "S1", "R1", "R2"])
      assert.ok(ok.some((m) => m.startsWith(`ok ${label} `)), `${label} did not run`);
    assert.ok(ok.length >= 28, `${ok.length} checks ran`);
  } finally {
    await db.close();
  }
});
