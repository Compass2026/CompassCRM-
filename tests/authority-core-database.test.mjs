// Replays every migration into PGlite, runs the Core 50 scope suite
// (supabase/tests/sandbox/authority_core_scope.test.sql, also run natively by
// scripts/test-portal-sandbox.sh; its \ir lines inlined here), then hands
// authority_input_scoped() for its fictional clients to the engine before the
// suite's rollback: a database scope in, opportunities out. Fictional
// fixtures only; nothing is written outside the rolled-back transaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { runAuthority } from "../supabase/functions/authority/engine.ts";
import { coreVerdict } from "../supabase/functions/authority/core.ts";

const SUITE = "supabase/tests/sandbox/authority_core_scope.test.sql";
const LABELS = ["S1", "S2", "S3", "S4", "S5", "S6", "G1", "N1", "M1", "M2", "M3", "I1", "I2", "F1", "F2", "F3", "E1", "X1", "X2", "W1", "T1", "R1", "R2"];

test("authority_core_scope: database suite, then the engine over authority_input_scoped()", async () => {
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
      .replace(/^\\ir (.+)$/gm, (_, rel) => readFileSync(path.join(path.dirname(SUITE), rel), "utf8"))
      .replace(/\nrollback;\s*$/, "\n");   // keep the fixtures for the engine below
    await db.exec(suite, { onNotice: (n) => notices.push(n.message) });
    const ok = notices.filter((m) => m.startsWith("ok "));
    for (const label of LABELS) assert.ok(ok.some((m) => m.startsWith(`ok ${label} `)), `${label} did not run`);
    assert.equal(ok.length, LABELS.length);

    const id = async (k) => (await db.query("select acs.id($1) id", [k])).rows[0].id;
    await db.exec("select acs.as_user('acc00000-0000-4000-a000-000000000001')");
    // The site as fetched: home and every approved service page, live.
    const live = (url) => ({ url, status: 200, final_url: url, final_status: 200, redirect_loop: false, in_sitemap: true,
      title: null, h1: null, h2: [], canonical: url, words: 600, text: "" });
    const input = async (code) => {
      const i = (await db.query("select authority_input_scoped(acs.id($1)) i", [code])).rows[0].i;
      i.authority.places = [];
      i.authority.inventory = { fetched_at: i.authority.now, pages: [live(`${i.client.website_url}/`), ...i.services.map((s) => live(s.page_url))] };
      return i;
    };
    const posts = (r) => r.opportunities.filter((o) => o.key.startsWith("gbp_post:"));

    // A: every Business Profile target the engine calls ready is in the
    // approved v2 list (or its child), with a usable owner and no place
    // problem; everything else is blocked with its Core 50 code.
    const a = await input("A");
    const scoped = new Map(a.authority.core.keywords.map((k) => [k.keyword_id, k]));
    const ra = runAuthority(a);
    assert.equal(ra.version, "authority-v1.5");
    assert.ok(posts(ra).length > 0);
    for (const o of posts(ra)) {
      assert.equal(o.core.list_id, await id("A:l2"));
      assert.equal(o.core.list_version, 2);
      const k = scoped.get(o.target.keyword_id);
      if (o.gates.find((g) => g.gate === "core_keyword").pass) {
        assert.ok(k, `${o.key} targets ${o.target.keyword}, which v2 does not ground`);
        assert.equal(k.purposes.post, null);
        assert.ok(["structured", "none"].includes(k.geography));
      } else {
        assert.notEqual(o.section, "ready");
        assert.equal(o.action, "blocked_data_prerequisite");
      }
    }
    for (const off of ["A:k3", "A:k52", "A:k55", "A:k58", "A:k60"]) {
      const kid = await id(off);
      assert.ok(!posts(ra).some((o) => o.section === "ready" && o.target.keyword_id === kid), `${off} became ready`);
      assert.ok(["off_list", "not_loaded"].includes(ra.keywords.find((k) => k.keyword_id === kid)?.core?.status ?? "off_list"));
    }
    // Core 50 passes for the usable ones, which then meet the drafter's own
    // brief (this fictional client has no brand board, so it refuses them);
    // service 2's keywords (page checked 46 days ago) stop at Core 50.
    assert.ok(posts(ra).some((o) => o.gates.find((g) => g.gate === "core_keyword").pass && o.gates.some((g) => g.gate === "drafter_brief" && /brand_board_missing/.test(g.detail))));
    assert.ok(posts(ra).some((o) => o.core.verdict === "page_not_verified" && o.section === "blocked"));
    assert.deepEqual(ra.core.refused, { page_not_verified: 3 });
    assert.equal(ra.core.programs[0].list_version, 2);
    assert.equal(ra.core.programs[0].keyword_ids.length, 50);

    // G: a proposal only. Nothing is ready, one decision names the proposal.
    const rg = runAuthority(await input("G"));
    assert.ok(!rg.opportunities.some((o) => o.section === "ready"));
    assert.ok(posts(rg).every((o) => o.core.verdict === "core_list_not_approved"));
    const dg = rg.opportunities.find((o) => o.key === "core_list:client");
    assert.equal(dg.action, "requires_confirmation");
    assert.match(dg.gap, /v1 \(50 keywords\) is proposed, not approved/);

    // M: M1 approved in the suite; M2 and M3 proposals. Only M1's services
    // can be ready, only with M1's keywords; M2 / M3 get one decision each.
    const m = await input("M");
    const rm = runAuthority(m);
    const m1 = await id("M1");
    const m1Services = new Set(m.authority.core.programs.find((p) => p.program_id === m1).service_ids);
    for (const o of posts(rm)) {
      if (!m1Services.has(o.service_id)) assert.equal(o.core.verdict, "core_list_not_approved", o.key);
      else if (o.core.verdict === null) assert.equal(o.core.program_id, m1);
    }
    // The verdict per keyword and service, over the database's own scope.
    const svc = (k) => m.keywords.find((x) => x.id === k)?.service_id ?? null;
    const [m1k1, m1k12, m2k10, m2k11, m1s] = [await id("M1:k1"), await id("M1:k12"), await id("M2:k10"), await id("M2:k11"), await id("M1:s1")];
    assert.equal(coreVerdict(m, m1k1, svc(m1k1), "post").ok, true);
    assert.equal(coreVerdict(m, m1k1, svc(m1k1), "post").receipt.program_id, m1);
    assert.equal(coreVerdict(m, m2k10, m1s, "post").receipt.verdict, "keyword_not_core", "M2's phrase never qualifies M1");
    assert.equal(coreVerdict(m, m2k10, svc(m2k10), "post").receipt.verdict, "core_list_not_approved");
    assert.equal(coreVerdict(m, m2k11, m1s, "post").receipt.verdict, "keyword_not_core", "M1's list naming M2's row grounds nothing");
    assert.equal(coreVerdict(m, m1k12, m1s, "post").receipt.verdict, "keyword_not_core", "a keyword whose page is on M2's host");
    assert.deepEqual(rm.opportunities.filter((o) => o.key.startsWith("core_list:")).map((o) => o.key).sort(),
      [`core_list:${await id("M2")}`, `core_list:${await id("M3")}`].sort());
    const m2kw = await id("M2:k10");
    assert.ok(!rm.opportunities.some((o) => o.section === "ready" && o.target.keyword_id === m2kw));
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});
