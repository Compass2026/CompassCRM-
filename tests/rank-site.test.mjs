// Which website a tracked keyword's rank is measured against
// (supabase/functions/_shared/rank-site.ts, used by rank-sync and the
// Keywords page). Fictional clients only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordSite, onKeywordSite, rankHost } from "../supabase/functions/_shared/rank-site.ts";

const sites = [
  { id: "s-safety", url: "https://safety.example.test/" },
  { id: "s-lift", url: "https://www.lift.example.test/" },
  { id: "s-heavy", url: "https://www.heavy.example.test/" },
];
const programs = [
  { id: "w-safety", name: "Safety", website_url: "https://safety.example.test/", blog_site_id: "s-safety", service_ids: ["svc-osha", "svc-cpr"] },
  { id: "w-lift", name: "Lift", website_url: "https://www.lift.example.test/", blog_site_id: "s-lift", service_ids: ["svc-forklift"] },
  { id: "w-heavy", name: "Heavy", website_url: "https://www.heavy.example.test/", blog_site_id: "s-heavy", service_ids: ["svc-excavator"] },
];
const shuffle = (xs, seed) => [...xs].sort((a, b) => ((a.id.charCodeAt(2) * seed) % 7) - ((b.id.charCodeAt(2) * seed) % 7));
const multi = (seed) => ({ name: "Example Group LLC", dba: null, website_url: "https://safety.example.test/", sites: shuffle(sites, seed), client_brand_workspaces: shuffle(programs, seed + 1) });

test("three brand sites in any order: each keyword resolves to the site that owns its service", () => {
  for (const seed of [1, 2, 3, 5]) {
    const c = multi(seed);
    assert.deepEqual(keywordSite(c, { service_id: "svc-forklift" }), { ok: true, host: "lift.example.test", program: "w-lift", names: ["Lift", "Example Group LLC"] });
    assert.equal(keywordSite(c, { service_id: "svc-excavator" }).host, "heavy.example.test");
    assert.equal(keywordSite(c, { service_id: "svc-osha" }).host, "safety.example.test");
  }
});

test("the intended host (and its subdomains) counts; a sister brand's host never does", () => {
  const lift = keywordSite(multi(2), { service_id: "svc-forklift" });
  assert.ok(onKeywordSite("https://www.lift.example.test/classes", lift.host));
  assert.ok(onKeywordSite("blog.lift.example.test", lift.host));
  assert.ok(!onKeywordSite("https://safety.example.test/services/forklift", lift.host));
  assert.ok(!onKeywordSite("https://www.heavy.example.test/", lift.host));
  assert.ok(!onKeywordSite("lift.example.test.evil.test", lift.host));
  assert.ok(!onKeywordSite(null, lift.host));
});

test("a keyword no brand site owns, or several own, is a problem, never the first site", () => {
  assert.deepEqual(keywordSite(multi(1), { service_id: null }), { ok: false, problem: "it has no service, so no brand site owns it" });
  assert.deepEqual(keywordSite(multi(1), { service_id: "svc-unknown" }), { ok: false, problem: "its service belongs to no brand site" });
  const twice = { ...multi(1), client_brand_workspaces: [...programs, { id: "w-dup", name: "Dup", website_url: "https://dup.example.test/", blog_site_id: null, service_ids: ["svc-forklift"] }] };
  assert.equal(keywordSite(twice, { service_id: "svc-forklift" }).ok, false);
  const split = { ...multi(1), client_brand_workspaces: [{ ...programs[1], website_url: "https://other.example.test/" }] };
  assert.match(keywordSite(split, { service_id: "svc-forklift" }).problem, /records name 2 websites/);
});

test("a single-site client keeps its one website, www or not, with or without a service", () => {
  const single = { name: "Lucas-like Construction", dba: "Lucas", website_url: "https://example-build.test", sites: [{ id: "a", url: "https://www.example-build.test/" }] };
  assert.deepEqual(keywordSite(single, { service_id: null }), { ok: true, host: "example-build.test", program: null, names: ["Lucas-like Construction", "Lucas"] });
  assert.equal(keywordSite({ ...single, sites: null }, { service_id: "x" }).host, "example-build.test");
  assert.deepEqual(keywordSite({ ...single, website_url: null, sites: [] }, { service_id: null }), { ok: false, problem: "no website is recorded for this client" });
  assert.equal(keywordSite({ ...single, sites: [{ url: "https://elsewhere.test" }] }, { service_id: null }).ok, false);
});

test("hosts normalise like public.url_host", () => {
  assert.equal(rankHost("https://WWW.Lift.Example.Test:443/x"), "lift.example.test");
  assert.equal(rankHost("not a url"), null);
});
