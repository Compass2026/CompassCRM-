// owner-page-check (20261028170000): a 200 is not proof of a page. Fake
// fetch and resolver; no network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgePage } from "../supabase/functions/owner-page-check/check.ts";
import { createOwnerPageCheck } from "../supabase/functions/owner-page-check/handler.ts";

const SITE = "https://www.ridgeline.example.test";
const page = (title, h1, extra = "") => `<html><head><title>${title}</title>${extra}</head><body><h1>${h1}</h1><p>${title} body text.</p></body></html>`;
const got = (status, finalUrl, html) => ({ status, finalUrl, html });

test("live: answered at the address asked, a title and H1, unlike the host's not-found probe", async () => {
  const v = await judgePage(`${SITE}/services/roof-repair`, SITE, got(200, "https://ridgeline.example.test/services/roof-repair/", page("Roof Repair", "Roof repair in Oakfield")),
    got(404, `${SITE}/x`, "<h1>Not found</h1>"));
  assert.equal(v.verdict, "live");
  assert.equal(v.h1, "Roof repair in Oakfield");
});

test("missing, wrong host, redirected, canonical elsewhere, unreadable", async () => {
  const probe = got(404, `${SITE}/x`, "");
  assert.equal((await judgePage(`${SITE}/a`, SITE, got(404, `${SITE}/a`, ""), probe)).verdict, "missing");
  assert.equal((await judgePage(`${SITE}/a`, SITE, got(200, "https://lender.example.test/a", page("A", "A")), probe)).verdict, "wrong_host");
  assert.equal((await judgePage(`${SITE}/a`, SITE, got(200, `${SITE}/`, page("Home", "Home")), probe)).verdict, "redirected");
  assert.equal((await judgePage(`${SITE}/a`, SITE, got(200, `${SITE}/a`, page("A", "A", `<link rel="canonical" href="/b">`)), probe)).verdict, "redirected");
  assert.equal((await judgePage(`${SITE}/a`, SITE, got(200, `${SITE}/a`, "<html><body><div id=root></div></body></html>"), probe)).verdict, "unreadable");
});

test("soft 404: the page says not found, or the host answers any path with the same page (an SPA)", async () => {
  const spa = page("Show Me Design", "Design build in St. Louis");
  assert.equal((await judgePage(`${SITE}/kitchens`, SITE, got(200, `${SITE}/kitchens`, spa), got(200, `${SITE}/nope`, spa))).verdict, "soft_404");
  assert.equal((await judgePage(`${SITE}/a`, SITE, got(200, `${SITE}/a`, page("Oops", "Page not found")), got(404, `${SITE}/x`, ""))).verdict, "soft_404");
});

test("the handler checks each owner page once, probes each host once and records every verdict", async () => {
  const recorded = [];
  const calls = [];
  const store = {
    async secret() { return "cron-secret"; },
    async teamMember() { return null; },
    async targets() { return [
      { url: `${SITE}/services/roof-repair`, site_url: SITE, keyword_count: 3 },
      { url: `${SITE}/service-areas/oakfield`, site_url: SITE, keyword_count: 1 },
    ]; },
    async record(row) { recorded.push(row); },
  };
  const fetch = async (url) => {
    calls.push(url);
    if (url.includes("does-not-exist")) return new Response("<h1>Not found</h1>", { status: 404 });
    if (url.endsWith("/oakfield")) return new Response(null, { status: 301, headers: { location: `${SITE}/` } });
    if (url === `${SITE}/`) return new Response(page("Home", "Ridgeline"), { status: 200 });
    return new Response(page("Roof Repair", "Roof repair"), { status: 200 });
  };
  const h = createOwnerPageCheck({ store, fetch, resolve: async () => ["93.184.216.34"], runId: () => "run-0001-abcdef" });
  const r = await h.handle(new Request("https://x/owner-page-check", { method: "POST", headers: { "x-cron-secret": "cron-secret" },
    body: JSON.stringify({ client_id: "00000000-0000-4000-8000-000000000001" }) }));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.checked, 2);
  assert.deepEqual(recorded.map((x) => x.verdict), ["live", "redirected"]);
  assert.ok(recorded.every((x) => x.method === "http" && x.source_ref === "owner-page-check:run-0001-abcdef"));
  assert.equal(calls.filter((u) => u.includes("does-not-exist")).length, 1);
});

test("the handler refuses strangers and private addresses", async () => {
  const store = { async secret() { return "s"; }, async teamMember() { return null; }, async targets() { return [{ url: `${SITE}/a`, site_url: SITE, keyword_count: 1 }]; }, recorded: [],
    async record(row) { this.recorded.push(row); } };
  const h = createOwnerPageCheck({ store, fetch: async () => new Response(page("A", "A")), resolve: async () => ["10.0.0.5"] });
  const anon = await h.handle(new Request("https://x", { method: "POST", body: "{}" }));
  assert.equal(anon.status, 401);
  const r = await h.handle(new Request("https://x", { method: "POST", headers: { "x-cron-secret": "s" }, body: JSON.stringify({ client_id: "00000000-0000-4000-8000-000000000001" }) }));
  assert.equal((await r.json()).results[0].verdict, "missing");
});
