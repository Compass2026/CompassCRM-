// The keyword owner resolver (20261028170000): the TypeScript twin of SQL's
// keyword_owner(), on the shared fixture tests/fixtures/keyword-owner-cases.json
// that supabase/tests/sandbox/keyword_owner_resolver.test.sql loads into the
// database. Same rows, same expected code, role and owner URL for every case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  approvedMarketPlaces, ownerAllows, ownerHost, ownerNormUrl, promotionHold, resolveKeywordOwner, siteOfKeyword,
} from "../supabase/functions/authority/keyword-owner.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/keyword-owner-cases.json", import.meta.url), "utf8"));
// md5(key)::uuid, as the SQL suite builds its ids.
export const id = (k) => {
  const h = createHash("md5").update(k).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const asOf = "2026-10-28T12:00:00Z";

// The owner_context keyword_owner_context() returns for one client, built from the fixture.
export function contextFor(clientKey, overrides = {}) {
  const mine = (x) => x.client === clientKey;
  const client = fx.clients.find((c) => c.key === clientKey);
  const ws = fx.workspaces.filter(mine);
  return {
    enforce: true,
    program_id: null,
    site_url: client.website_url,
    workspaces: ws.map((w) => ({ id: id(w.key), name: w.name, website_url: w.website_url, service_ids: w.services.map(id) })),
    keywords: fx.keywords.filter(mine).map((k) => ({
      id: id(k.key), keyword: k.keyword, is_active: k.is_active ?? true, intent: k.intent ?? null,
      service_id: k.service ? id(k.service) : null, target_url: k.target_url ?? null, city: k.city ?? null,
      market_id: k.market ? id(k.market) : null, core_parent_keyword_id: k.parent ? id(k.parent) : null,
    })),
    services: fx.services.filter(mine).map((s) => ({ id: id(s.key), status: s.status, page_url: s.page_url, primary_keyword_id: s.primary ? id(s.primary) : null })),
    page_groups: fx.page_groups.filter(mine).map((g, i) => ({
      id: id(g.key), status: g.status ?? "approved", page_type: g.page_type, target_url: g.target_url,
      primary_keyword_id: g.primary ? id(g.primary) : null, created_at: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z`,
    })),
    published_posts: fx.published_posts.filter(mine).map((p) => ({ id: id(p.key), url: p.url })),
    markets: fx.markets.filter(mine).map((m) => ({
      id: id(m.key), brand_workspace_id: m.workspace ? id(m.workspace) : null, city: m.city, state: m.state, status: m.status,
      basis: m.basis, source_ref: "test fixture",
    })),
    page_checks: fx.page_checks.filter(mine).map((c) => ({ url_norm: ownerNormUrl(c.url), verdict: c.verdict, checked_at: asOf })),
    holds: fx.holds.filter(mine).map((h) => ({
      id: id(h.key), brand_workspace_id: null, offering: h.offering, phrases: h.phrases.map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()),
      service_ids: h.services.map(id), decided_on: "2026-10-28", source_ref: "test fixture",
    })),
    as_of: asOf,
    ...overrides,
  };
}

const clientOf = (kw) => fx.keywords.find((k) => k.key === kw).client;

test("every shared case gives the code, role and owner URL keyword_owner() gives", () => {
  const bad = [];
  for (const c of fx.cases) {
    const r = resolveKeywordOwner(contextFor(clientOf(c.keyword)), id(c.keyword), { program: c.program ? id(c.program) : null, purpose: c.purpose ?? null });
    const code = r.ok ? null : r.code;
    const role = r.ok ? r.owner.role : r.partial.role;
    const url = r.ok ? r.owner.url : r.partial.url;
    if (code !== (c.expect.code ?? null) || ("role" in c.expect && role !== c.expect.role) || ("url" in c.expect && url !== c.expect.url)) {
      bad.push(`${c.name}: got ${JSON.stringify({ code, role, url, message: r.ok ? null : r.message })}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(fx.cases.length >= 40);
});

test("URL and host normalisation match core_norm_url / core_url_host", () => {
  assert.equal(ownerNormUrl("HTTPS://WWW.Ridgeline.Example.Test/Service-Areas/Oakfield/?utm=1#x"), "https://ridgeline.example.test/service-areas/oakfield");
  assert.equal(ownerNormUrl("/osage-beach", "https://www.lake.example.test/"), "https://lake.example.test/osage-beach");
  assert.equal(ownerNormUrl("https://a.example.test:8443/x"), "https://a.example.test/x");
  assert.equal(ownerNormUrl("a.example.test/x"), null);
  assert.equal(ownerNormUrl("/x"), null);
  assert.equal(ownerNormUrl(""), null);
  assert.equal(ownerHost("https://www.A.example.test/x"), "a.example.test");
});

test("the role table matches core_owner_allows", () => {
  assert.ok(ownerAllows("home", "post", "transactional") && !ownerAllows("home", "blog", "informational"));
  assert.ok(ownerAllows("brand", "post", "commercial") && ownerAllows("brand", "post", "navigational") && !ownerAllows("brand", "post", "informational"));
  assert.ok(ownerAllows("city", "blog", "informational") && !ownerAllows("city", "blog", "commercial"));
  assert.ok(!ownerAllows("blog", "refresh", "informational") && ownerAllows("service", "refresh", "commercial") && !ownerAllows("nope", "post", "commercial"));
});

test("site of a keyword: by service, else the one site its own pages are on", () => {
  const h = contextFor("H");
  assert.equal(siteOfKeyword(h, id("kHouston")), id("H.lift"));
  assert.equal(siteOfKeyword(h, id("kSafeCo")), id("H.safe"));
  assert.equal(siteOfKeyword(h, id("kSafeCoLift")), id("H.lift"));
  assert.equal(siteOfKeyword(h, id("kTwoHosts")), null);
  assert.equal(siteOfKeyword(contextFor("R"), id("kRoof")), null);
});

test("held phrases match whole words; the held service's page is held", () => {
  const r = contextFor("R");
  assert.match(promotionHold(r, null, "We do THIRD-party roof repair too", null, null), /^Repairs on systems/);
  assert.equal(promotionHold(r, null, "third party roof repairs", null, null), null);
  assert.match(promotionHold(r, null, null, null, "https://www.ridgeline.example.test/services/other-repair/"), /^Repairs on systems/);
});

test("a stale live check is not verified; an exempt client is told, not refused", () => {
  const stale = contextFor("R", { as_of: "2027-01-15T00:00:00Z" });
  const r = resolveKeywordOwner(stale, id("kRoof"));
  assert.equal(r.ok, false);
  assert.equal(r.code, "page_not_verified");
  const exempt = contextFor("R", { enforce: false });
  const e = resolveKeywordOwner(exempt, id("kNotChecked"));
  assert.equal(e.ok, true);
  assert.match(e.notes.join(" "), /page_not_verified/);
  // Holds and conflicts are never relaxed.
  assert.equal(resolveKeywordOwner(exempt, id("kHeldKw")).code, "promotion_held");
  assert.equal(resolveKeywordOwner(exempt, id("kConflict")).code, "keyword_owner_conflict");
});

test("approved market places are the program's approved markets only", () => {
  assert.deepEqual(approvedMarketPlaces(contextFor("R"), null).sort(), ["Brookside", "Oakfield", "Springfield", "Springfield"]);
  assert.deepEqual(approvedMarketPlaces(contextFor("H"), id("H.safe")), ["Hannibal"]);
});
