// The read-only Zernio client (supabase/functions/social-history/zernio.ts):
// the credential can only be used to read. Every request is a GET with no
// body to an allowlisted path and query; nothing else ever reaches fetch;
// no other code in the function, and no other function, talks to Zernio or
// reads the key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  allowedRequest, createZernioReader, ZernioError, ZERNIO_GET_ALLOWLIST, ZERNIO_KEY_SECRET,
} from "../supabase/functions/social-history/zernio.ts";
import { ACCOUNT, FAKE_KEY, fakeZernio } from "./fixtures/zernio-fake.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FN_DIR = join(ROOT, "supabase/functions/social-history");

test("the reader exposes read methods only", () => {
  const z = createZernioReader({ apiKey: FAKE_KEY, fetch: fakeZernio().fetch });
  assert.deepEqual(Object.keys(z).sort(), ["analyticsPage", "facebookAccounts", "facebookPage", "profiles"]);
});

test("every request the reader makes is a GET with no body, to zernio.com, with the key in the header only", async () => {
  const f = fakeZernio();
  const z = createZernioReader({ apiKey: FAKE_KEY, fetch: f.fetch });
  await z.profiles();
  await z.facebookAccounts();
  await z.facebookPage(ACCOUNT);
  await z.analyticsPage({ accountId: ACCOUNT, fromDate: "2025-10-07", page: 1, limit: 20 });
  assert.equal(f.violations.length, 0);
  assert.equal(f.requests.length, 4);
  for (const r of f.requests) {
    assert.equal(r.method, "GET");
    assert.equal(r.hasBody, false);
    assert.equal(r.auth, `Bearer ${FAKE_KEY}`);
    assert.ok(!JSON.stringify(r.query).includes(FAKE_KEY), "the key is never in a URL");
  }
  assert.deepEqual(f.requests.map((r) => r.path), ["/api/v1/profiles", "/api/v1/accounts", `/api/v1/accounts/${ACCOUNT}/facebook-page`, "/api/v1/analytics"]);
  assert.deepEqual(f.requests[3].query, { accountId: ACCOUNT, platform: "facebook", source: "all", fromDate: "2025-10-07", limit: "20", page: "1", sortBy: "date", order: "desc" });
});

test("a write path, an unknown path or an unlisted query is refused before fetch is called", () => {
  for (const path of [
    "/v1/posts", "/v1/posts/sync-external", "/v1/posts/abc/unpublish", "/v1/connect/facebook",
    `/v1/accounts/${ACCOUNT}`, "/v1/inbox/comments", "/v1/webhooks/settings", "/v1/api-keys", "/v1/media/upload",
    `/v1/accounts/${ACCOUNT}/facebook-page/../../posts`, "/v1/analytics/delta", "/v1/profiles/x",
  ]) {
    assert.throws(() => allowedRequest(path, {}), (e) => e instanceof ZernioError && e.code === "path_not_allowed", path);
  }
  assert.throws(() => allowedRequest("/v1/analytics", { postId: "x" }), (e) => e.code === "query_not_allowed");
  assert.throws(() => allowedRequest("/v1/accounts/" + ACCOUNT + "/facebook-page", { refresh: "true" }), (e) => e.code === "query_not_allowed");
});

test("the allowlist names exactly four GET paths, none of them a write", () => {
  assert.deepEqual(ZERNIO_GET_ALLOWLIST.map((r) => r.path.source), [
    "^\\/v1\\/profiles$", "^\\/v1\\/accounts$", "^\\/v1\\/accounts\\/[0-9a-f]{24}\\/facebook-page$", "^\\/v1\\/analytics$",
  ]);
});

test("Zernio's errors become ZernioError without the key; a short 429 is retried once", async () => {
  const f401 = fakeZernio({ key: "sk_" + "1".repeat(64) });
  await assert.rejects(createZernioReader({ apiKey: FAKE_KEY, fetch: f401.fetch }).profiles(),
    (e) => e instanceof ZernioError && e.status === 401 && !e.message.includes(FAKE_KEY));
  const echo = async () => new Response(JSON.stringify({ error: `bad key ${FAKE_KEY}` }), { status: 403 });
  await assert.rejects(createZernioReader({ apiKey: FAKE_KEY, fetch: echo }).profiles(),
    (e) => e.status === 403 && !e.message.includes(FAKE_KEY) && e.message.includes("[key]"));

  const slept = [];
  const f429 = fakeZernio({ rateLimitOnPage: 1, retryAfter: 2 });
  const z = createZernioReader({ apiKey: FAKE_KEY, fetch: f429.fetch, sleep: async (ms) => { slept.push(ms); } });
  const r = await z.analyticsPage({ accountId: ACCOUNT, fromDate: "2025-10-07", page: 1, limit: 5 });
  assert.equal(r.posts.length, 5);
  assert.deepEqual(slept, [2000]);
  const long = fakeZernio({ rateLimitOnPage: 1, retryAfter: 600 });
  await assert.rejects(createZernioReader({ apiKey: FAKE_KEY, fetch: long.fetch, sleep: async () => {} })
    .analyticsPage({ accountId: ACCOUNT, fromDate: "2025-10-07", page: 1, limit: 5 }), (e) => e.status === 429 && e.transient);

  const down = async () => { throw new TypeError("network down"); };
  await assert.rejects(createZernioReader({ apiKey: FAKE_KEY, fetch: down }).profiles(), (e) => e.status === 0 && e.transient);
});

test("an empty or malformed key is refused before any request", () => {
  assert.throws(() => createZernioReader({ apiKey: "", fetch: fakeZernio().fetch }), (e) => e.code === "key_invalid");
  assert.throws(() => createZernioReader({ apiKey: "sk_ abc", fetch: fakeZernio().fetch }), (e) => e.code === "key_invalid");
});

// ── Static: nothing in the function can send anything but GET ─────────────────
function files(dir, ext = /\.(ts|tsx|mjs|js)$/) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : [];
  });
}

test("social-history's sources name no HTTP method but GET, and only zernio.ts makes requests", () => {
  for (const f of files(FN_DIR)) {
    const src = readFileSync(f, "utf8");
    const methods = [...src.matchAll(/method\s*:\s*["'`](\w+)["'`]/g)].map((m) => m[1]);
    assert.deepEqual(methods.filter((m) => m !== "GET"), [], `${f} names another method`);
    assert.ok(!/["'`](POST|PUT|PATCH|DELETE)["'`]/.test(src.replace(/req\.method !== "POST"/g, "")), `${f} mentions a write method`);
    if (!f.endsWith("zernio.ts")) {
      assert.ok(!/\bfetch\s*\(/.test(src.replace(/deps\.fetch|fetch\?:|typeof fetch/g, "")), `${f} calls fetch directly`);
      assert.ok(!/zernio\.com/.test(src), `${f} names Zernio's host`);
    }
  }
});

test("no other Edge Function or app code reads the Zernio key or talks to Zernio", () => {
  const all = [...files(join(ROOT, "supabase/functions")), ...files(join(ROOT, "src")), ...files(join(ROOT, "billing"))];
  const offenders = all.filter((f) => !f.startsWith(FN_DIR) && /ZERNIO|zernio\.com|getlate\.dev|LATE_API_KEY/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
  assert.equal(ZERNIO_KEY_SECRET, "ZERNIO_READ_API_KEY");
});
