// Replays every migration into PGlite and runs the claim verification suite
// (supabase/tests/sandbox/claim_verification.test.sql, also run natively by
// scripts/test-portal-sandbox.sh). Its \ir lines (the down script, the
// migration re-applied) are inlined here; the "pglite:skip" region needs a
// non-superuser postgres, which PGlite does not have. Fictional fixtures only.
//
// B3 runs here, not in the SQL: after the suite, with its decisions and
// evidence still in the open transaction, the rollback script must refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const SUITE = "supabase/tests/sandbox/claim_verification.test.sql";
const DOWN = "supabase/rollback/20261104200000_claim_verification.down.sql";
const NATIVE_ONLY = ["E7j", "H3", "S12"];

test("claim verification: authority, evidence, ledger, projection, registry, audit, rollback", async () => {
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
      .replace(/^\\ir (.+)$/gm, (_, rel) => readFileSync(path.join(path.dirname(SUITE), rel), "utf8"))
      .replace(/^rollback;\s*$/m, "");
    try { await db.exec(suite, { onNotice: (n) => notices.push(n.message) }); } catch (e) { throw new Error(`${e.message} after: ${notices.slice(-3).join(" / ")}`); }
    const ok = notices.filter((m) => m.startsWith("ok ")).map((m) => m.split(" ")[1]);
    const expected = [...readFileSync(SUITE, "utf8").matchAll(/cvt\.ok\('([A-Z]\d+[a-z]?) /g)].map((m) => m[1]);
    assert.ok(expected.length >= 45, `only ${expected.length} checks found in the suite`);
    assert.deepEqual(ok, expected.filter((l) => !NATIVE_ONLY.includes(l)));

    // B3: history and evidence exist now; the rollback refuses and changes nothing.
    await assert.rejects(db.exec(readFileSync(DOWN, "utf8")), /recorded history or evidence: it is kept/);
    await db.exec("rollback");
  } finally {
    await db.close();
  }
});
