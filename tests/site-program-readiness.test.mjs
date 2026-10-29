// site_program_readiness wording (src/lib/site-program-readiness.ts), the
// generated place seed and its normalizer. Pure: no database. The fixture is
// the function's own output for the sandbox suite's fictional clients G
// (place in text), M (three brand sites) and N (nothing recorded).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderReadiness, programLines, fig, reasonText, REASON_TEXT, NOT_VERIFIED, STATUS_LABEL } from "../src/lib/site-program-readiness.ts";
import { buildSeed, normPlace, SOURCE, SEED } from "../scripts/build-place-names-seed.mjs";
import { normPlace as enginePlace } from "../supabase/functions/authority/urls.ts";

const fixture = JSON.parse(fs.readFileSync("tests/fixtures/site-program-readiness.json", "utf8"));
const MIGRATION = fs.readFileSync("supabase/migrations/20261029200000_site_program_readiness.sql", "utf8");

test("the place seed is exactly what the generator writes from the bundled city list", () => {
  const { sql, count, sha } = buildSeed(fs.readFileSync(SOURCE, "utf8"));
  assert.equal(fs.readFileSync(SEED, "utf8"), sql, "regenerate with scripts/build-place-names-seed.mjs");
  assert.ok(count > 20000);
  assert.match(sql, new RegExp(`source_sha256 = '${sha}'`));
  assert.doesNotMatch(sql, /\('(arcadia|liberty|independence|union)', /, "common-word places are left out");
});

test("the seed's normalizer is the Authority engine's normPlace", () => {
  for (const s of ["St. Louis", "Lake St. Louis", "O'Fallon", "Saint Charles", "Coeur d'Alene", "Winston-Salem", "1st Street Station"])
    assert.equal(normPlace(s), enginePlace(s).trim(), s);
});

test("every reason and warning code the migration emits has wording", () => {
  const codes = new Set([...MIGRATION.matchAll(/'code', '([a-z_]+)'(?!\s*\|\|)/g)].map((m) => m[1]));
  for (const k of ["text_only", "without_market", "mismatch"]) codes.add(`place_${k}`);
  assert.ok(codes.size >= 25);
  for (const c of codes) assert.ok(REASON_TEXT[c], `no wording for ${c}`);
  assert.match(reasonText("owner:keyword_wrong_page"), /keyword wrong page/);
});

test("an unknown figure is NOT VERIFIED, never 0", () => {
  assert.equal(fig(null), NOT_VERIFIED);
  assert.equal(fig(undefined), NOT_VERIFIED);
  assert.equal(fig(0), "0");
  const n = renderReadiness(fixture.N);
  assert.match(n, /Core 50: NOT VERIFIED \(no list\)/);
  assert.doesNotMatch(n, /Intents:|Owners ok:|Owner pages:/, "no zero rows for a list that does not exist");
});

test("client-wide claims and photos are not shown as site evidence", () => {
  const m1 = fixture.M.programs.find((p) => p.name === "SPR M1");
  assert.equal(m1.claims.site_usable, null);
  assert.equal(m1.proof.site_own_work_approved, null);
  const lines = programLines(m1).join("\n");
  assert.match(lines, /Claims \(client\): usable 4 .*this site NOT VERIFIED/);
  assert.match(lines, /Proof \(client\): own-work reviewed 8 of 8 photos; this site NOT VERIFIED/);
  assert.match(lines, /Gate B READY · Gate C NOT VERIFIED/);
});

test("a gate is labelled READY only when the database says ready", () => {
  for (const r of [fixture.G, fixture.M, fixture.N])
    for (const p of r.programs) {
      const head = programLines(p)[1];
      assert.equal(head, `  Gate B ${STATUS_LABEL[p.gate_b.status]} · Gate C ${STATUS_LABEL[p.gate_c.status]}`);
      if (p.gate_b.reasons.length) assert.notEqual(p.gate_b.status, "ready");
      if (p.gate_c.reasons.length) assert.notEqual(p.gate_c.status, "ready");
    }
  const g = renderReadiness(fixture.G);
  assert.match(g, /Gate B BLOCKED/);
  assert.match(g, /"zqx interior designer troy il": place without_market \[Troy, IL\]/);
  assert.match(g, /"zqx interior designer edwardsville il": place text_only \[Edwardsville, IL \(market\)\]/);
});

test("every report says Gate C is not permission to publish", () => {
  assert.match(renderReadiness(fixture.M), /never permission to publish/);
});
