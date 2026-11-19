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
    const suite = readFileSync(SUITE, "utf8")
      .replace(/^-- pglite:skip-begin[\s\S]*?^-- pglite:skip-end$/m, "")
      .replace(/^\\ir (.+)$/gm, (_, rel) => readFileSync(path.join(path.dirname(SUITE), rel), "utf8"));
    await db.exec(suite, { onNotice: (n) => notices.push(n.message) });
    const ok = notices.filter((m) => m.startsWith("ok "));
    for (const label of ["U1", "U2", "U3", "U4", "U5", "U8", "U9", "U10", "B1", "B4", "B5", "B8", "C1", "M2", "M3", "E1",
                         "H1", "H2", "H3", "X2", "X3", "X5", "W1", "S1", "R1", "R2"])
      assert.ok(ok.some((m) => m.startsWith(`ok ${label} `)), `${label} did not run`);
    assert.equal(ok.length, 38, `${ok.length} checks ran (39 natively; U6 runs below)`);

    // U6 outside the script (an error aborts a PGlite script): over an
    // altered and incomplete reference the seed raises and keeps nothing.
    const seed = readFileSync("supabase/seeds/place-names-v1.sql", "utf8");
    const status = async () => (await db.query("select place_reference_status() s")).rows[0].s;
    await db.exec(seed);
    assert.equal((await status()).ok, true);
    await db.exec("update place_names set population = population + 1 where norm = 'troy' and state = 'IL'");
    await db.exec("delete from place_names where state = 'TX' and norm in (select norm from place_names where state = 'TX' order by norm limit 100)");
    await assert.rejects(db.exec(seed), /place-names-v1 did not verify \(rows_mismatch\): nothing was loaded/);
    assert.equal((await db.query("select count(*)::int n from place_names")).rows[0].n, 21216);
    assert.equal((await status()).problem, "partial");
    await db.exec("update place_names set population = population - 1 where norm = 'troy' and state = 'IL'");
    await db.exec(seed);
    assert.equal((await status()).ok, true);
  } finally {
    await db.close();
  }
});
