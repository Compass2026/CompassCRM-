// Replays every migration into PGlite and runs the claims registry suite
// (supabase/tests/sandbox/claim_registry.test.sql, also run natively by
// scripts/test-portal-sandbox.sh). Its \ir lines (the down script, the
// migration re-applied) are inlined here; the "pglite:skip" region needs a
// non-superuser postgres, which PGlite does not have. Fictional fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const SUITE = "supabase/tests/sandbox/claim_registry.test.sql";
const NATIVE_ONLY = ["A3", "A4"];

test("claim_registry: buckets, scope, guard, history, access, no writes, rollback", async () => {
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
    const suite = readFileSync(SUITE, "utf8")
      .replace(/^-- pglite:skip-begin[\s\S]*?^-- pglite:skip-end$/gm, "")
      .replace(/^\\ir (.+)$/gm, (_, rel) => readFileSync(path.join(path.dirname(SUITE), rel), "utf8"));
    await db.exec(suite, { onNotice: (n) => notices.push(n.message) });
    const ok = notices.filter((m) => m.startsWith("ok ")).map((m) => m.split(" ")[1]);
    const expected = [...readFileSync(SUITE, "utf8").matchAll(/crt\.ok\('([A-Z]\d+) /g)].map((m) => m[1]);
    assert.ok(expected.length >= 45, `only ${expected.length} checks found in the suite`);
    assert.deepEqual(ok, expected.filter((l) => !NATIVE_ONLY.includes(l)));
  } finally {
    await db.close();
  }
});
