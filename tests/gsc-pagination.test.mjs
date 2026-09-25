// gsc-sync pagination (_shared/gsc-paging.ts) and the handler that uses it:
// startRow paging to a short page or the safety cap, no duplicate rows, a
// failed page stores nothing, and the upsert keeps the natural key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAllRows, GSC_MAX_ROWS, GSC_PAGE_SIZE } from "../supabase/functions/_shared/gsc-paging.ts";
import { createGscSync } from "../supabase/functions/gsc-sync/handler.ts";

const row = (n) => ({ keys: [`q${n}`, `https://x.test/p${n % 7}`], clicks: 1, impressions: 10, ctr: 0.1, position: 5 });
// A fake Search Console holding `total` rows; records every request.
function source(total, { failAt = null, dupAt = null } = {}) {
  const calls = [];
  const fetchPage = async (startRow, rowLimit) => {
    calls.push({ startRow, rowLimit });
    if (failAt !== null && calls.length === failAt) return { ok: false, status: 503 };
    const rows = [];
    for (let i = startRow; i < Math.min(total, startRow + rowLimit); i++) rows.push(row(i));
    if (dupAt !== null && calls.length === dupAt && rows.length) rows.push(rows[0]); // Google repeats a row
    return { ok: true, rows };
  };
  return { fetchPage, calls };
}

test("one page: a short first page is the whole window", async () => {
  const s = source(120);
  const r = await fetchAllRows(s.fetchPage, { pageSize: 1000, maxRows: 10000 });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 120);
  assert.equal(r.capped, false);
  assert.deepEqual(s.calls, [{ startRow: 0, rowLimit: 1000 }]);
});

test("multiple pages: startRow advances until a short page", async () => {
  const s = source(2500);
  const r = await fetchAllRows(s.fetchPage, { pageSize: 1000, maxRows: 10000 });
  assert.equal(r.rows.length, 2500);
  assert.equal(r.capped, false);
  assert.deepEqual(s.calls.map((c) => c.startRow), [0, 1000, 2000]);
});

test("exact page-size boundary: a full last page is followed by an empty one, not treated as capped", async () => {
  const s = source(2000);
  const r = await fetchAllRows(s.fetchPage, { pageSize: 1000, maxRows: 10000 });
  assert.equal(r.rows.length, 2000);
  assert.equal(r.capped, false);
  assert.deepEqual(s.calls.map((c) => c.startRow), [0, 1000, 2000]);
});

test("final short page ends paging", async () => {
  const s = source(1001);
  const r = await fetchAllRows(s.fetchPage, { pageSize: 1000, maxRows: 10000 });
  assert.equal(r.rows.length, 1001);
  assert.equal(s.calls.length, 2);
  assert.equal(r.capped, false);
});

test("safety cap: paging stops at the cap and the window is marked capped", async () => {
  const s = source(50000);
  const r = await fetchAllRows(s.fetchPage, { pageSize: 1000, maxRows: 3000 });
  assert.equal(r.rows.length, 3000);
  assert.equal(r.capped, true);
  assert.equal(s.calls.length, 3);
  const r2 = await fetchAllRows(source(50000).fetchPage, { pageSize: 1000, maxRows: 2500 });
  assert.equal(r2.rows.length, 2500, "the last request asks only for what the cap allows");
  assert.equal(r2.capped, true);
  assert.equal(GSC_MAX_ROWS >= GSC_PAGE_SIZE, true);
});

test("duplicate protection: a repeated (query, page) is kept once", async () => {
  const s = source(1500, { dupAt: 2 });
  const r = await fetchAllRows(s.fetchPage, { pageSize: 1000, maxRows: 10000 });
  assert.equal(r.duplicates, 1);
  const keys = new Set(r.rows.map((x) => JSON.stringify(x.keys)));
  assert.equal(keys.size, r.rows.length);
});

test("API error mid-pagination fails the whole window: nothing partial is returned", async () => {
  const s = source(5000, { failAt: 3 });
  const r = await fetchAllRows(s.fetchPage, { pageSize: 1000, maxRows: 10000 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.pages, 3);
  assert.equal(r.rows, undefined);
});

// ── Through the real handler ──────────────────────────────────────────────
const CLIENT = "00000000-0000-4000-b000-0000000000aa";
function harness({ total, failAt = null }) {
  const upserts = [];
  let job = null;
  globalThis.EdgeRuntime = { waitUntil(p) { job = p; } };
  const secrets = { SYNC_CRON_SECRET: "cron", GSC_CLIENT_ID: "c", GSC_CLIENT_SECRET: "s", GSC_REFRESH_TOKEN: "r" };
  const tables = { clients: [{ id: CLIENT, name: "Lucas", website_url: "https://x.test", gsc_property: "sc-domain:x.test", status: "active" }], keywords: [{ id: "kw-1", keyword: "q3" }] };
  const from = (t) => {
    const b = {
      select() { return b; }, eq() { return b; }, neq() { return b; },
      upsert(v, o) { upserts.push({ table: t, rows: v, opts: o }); return { select: async () => ({ data: v.map((_, i) => ({ id: i })), error: null }) }; },
      update() { return b; },
      then(res) { return Promise.resolve({ data: tables[t] ?? [], error: null }).then(res); },
    };
    return b;
  };
  const supabase = { rpc: async (n, a) => ({ data: n === "get_secret" ? secrets[a.secret_name] : null }), from, auth: { getUser: async () => ({ data: null }) } };
  const queries = [];
  const fetch = async (url, init) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "t" });
    if (url.endsWith("/sites")) return Response.json({ siteEntry: [{ siteUrl: "sc-domain:x.test" }] });
    const body = JSON.parse(init.body);
    queries.push(body);
    if (failAt !== null && queries.length === failAt) return new Response("boom", { status: 500 });
    const rows = [];
    for (let i = body.startRow; i < Math.min(total, body.startRow + body.rowLimit); i++) rows.push(row(i));
    return Response.json({ rows });
  };
  const handle = createGscSync({ supabase, fetch });
  const run = async () => {
    const res = await handle(new Request("http://x/gsc-sync", { method: "POST", headers: { "x-cron-secret": "cron", "content-type": "application/json" }, body: JSON.stringify({ client_id: CLIENT }) }));
    await job;
    return res;
  };
  return { run, upserts, queries };
}

test("handler: pages with startRow, upserts every row once with the natural key", async () => {
  const h = harness({ total: 2300 });
  const res = await h.run();
  assert.equal(res.status, 202);
  assert.deepEqual(h.queries.map((q) => [q.startRow, q.rowLimit]), [[0, GSC_PAGE_SIZE], [1000, 1000], [2000, 1000]]);
  const rows = h.upserts.flatMap((u) => u.rows);
  assert.equal(rows.length, 2300);
  assert.equal(new Set(rows.map((r) => r.query + "|" + r.page)).size, 2300, "no duplicate (query, page)");
  for (const u of h.upserts) {
    assert.equal(u.table, "gsc_snapshots");
    assert.deepEqual(u.opts, { onConflict: "client_id,query,page,period_start,period_end", ignoreDuplicates: true });
    assert.ok(u.rows.length <= GSC_PAGE_SIZE);
  }
  assert.equal(rows.find((r) => r.query === "q3").keyword_id, "kw-1", "keyword matching unchanged");
});

test("handler: a failed page mid-window stores nothing for that client", async () => {
  const h = harness({ total: 2300, failAt: 2 });
  await h.run();
  assert.equal(h.upserts.length, 0);
});
