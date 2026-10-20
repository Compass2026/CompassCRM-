// Replays every migration into PGlite and runs the Citations Phase 1 database
// suite (supabase/tests/sandbox/citations.test.sql, also run natively by
// scripts/test-portal-sandbox.sh). Fictional fixtures only.
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

test("citations: import idempotency, separate dimensions, evidence, approvals and team-only access", async () => {
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
    await db.exec(readFileSync("supabase/tests/sandbox/citations.test.sql", "utf8"));
  } finally {
    await db.close();
  }
});
