// The content-approvals function's handler (20261019190532) over a fake
// store. The rules themselves (admin, policy, intent, version, review hash,
// destination, one transaction, replay) run in the database: the sandbox suite
// supabase/tests/sandbox/content_delegation.test.sql. Here: the key, request
// validation, and the honest mapping of outcomes (refused vs unknown).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContentApprovals, parseAuthorize } from "../supabase/functions/content-approvals/handler.ts";

const KEY = "delegation-secret-value";
const CLIENT = "70211d71-d9f4-46ab-abe2-ef39c41591fb";
const D1 = "a922bdfa-2adb-4a80-8fe2-c8f489beed00";
const D2 = "63344ed3-7e71-4a4a-943a-d8192dc1bf9d";
const HASH = "sha256:" + "a".repeat(64);

function fakeStore(o = {}) {
  const calls = [];
  const s = {
    calls,
    async secret(name) { calls.push(["secret", name]); return name === "EXECUTIVE_OS_DELEGATION_SECRET" ? (o.secret ?? KEY) : null; },
    async clientsNamed(name) { calls.push(["clientsNamed", name]); return (o.clients ?? [{ id: CLIENT, name: "Logic Solar" }]).filter((c) => c.name.toLowerCase().includes(name.toLowerCase())); },
    async batch(id, channel) { calls.push(["batch", id, channel]); return o.batch ?? { data: { client: { id, name: "Logic Solar" }, drafts: [] }, error: null }; },
    async record(p) { calls.push(["record", p]); if (o.recordThrows) throw new Error("fetch failed"); return o.record ?? { data: { id: "rcpt-1", status: "recorded" }, error: null }; },
    async execute(id) { calls.push(["execute", id]); if (o.executeThrows) throw new Error("fetch failed"); return o.execute ?? { data: { id, status: "executed", results: [] }, error: null }; },
    async refuse(id, code, message) { calls.push(["refuse", id, code, message]); return { data: { id, status: "refused", refusal_code: code }, error: null }; },
    async status(op) { calls.push(["status", op]); return o.status ?? { data: null, error: null }; },
  };
  return s;
}

const post = (body, key = KEY) => new Request("https://x.supabase.co/functions/v1/content-approvals", {
  method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-compass-delegation-key": key } : {}) }, body: JSON.stringify(body),
});
const authorizeBody = (o = {}) => ({
  mode: "authorize", operation_id: "exos-0f3c2b9e-1111", client_id: CLIENT, action: "approve_and_publish",
  items: [{ draft_id: D1, version: 6, review_hash: HASH }, { draft_id: D2, version: 4, review_hash: HASH }],
  destination_url: "https://www.logic-solar.com/",
  instruction: { text: "Approve and publish Logic Blogs A and B", channel: "claude", account_email: "thomas@compassmarketing.ai", executed_by: "Claude (Executive OS MCP)" },
  source_ref: { executive_os_execution_id: "0f3c2b9e" },
  ...o,
});
const call = (store, req) => createContentApprovals({ store }).handle(req);

test("only the delegation key opens the function", async () => {
  const s = fakeStore();
  assert.equal((await call(s, post({ mode: "version" }, null))).status, 403);
  assert.equal((await call(s, post({ mode: "version" }, "wrong"))).status, 403);
  assert.equal((await call(fakeStore({ secret: "" }), post({ mode: "version" }))).status, 403, "no secret in Vault: closed");
  const r = await call(s, post({ mode: "version" }));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).actions, ["approve", "publish", "approve_and_publish"]);
  const get = await call(s, new Request("https://x/functions/v1/content-approvals"));
  assert.equal(get.status, 405);
});

test("batch resolves a client by name and asks when it is ambiguous", async () => {
  let r = await call(fakeStore(), post({ mode: "batch", client_name: "logic" }));
  assert.equal(r.status, 200);
  r = await call(fakeStore(), post({ mode: "batch", client_name: "Nobody" }));
  assert.equal(r.status, 404);
  const two = fakeStore({ clients: [{ id: CLIENT, name: "Logic Solar" }, { id: D1, name: "Logic Roofing" }] });
  r = await call(two, post({ mode: "batch", client_name: "logic" }));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).candidates.length, 2);
  assert.ok(!two.calls.some(([n]) => n === "batch"), "nothing read for an ambiguous name");
});

test("authorize validates the scope before anything is recorded", () => {
  assert.match(parseAuthorize(authorizeBody({ operation_id: "short" })), /operation_id/);
  assert.match(parseAuthorize(authorizeBody({ action: "publish_everything" })), /action/);
  assert.match(parseAuthorize(authorizeBody({ items: [] })), /1–50/);
  assert.match(parseAuthorize(authorizeBody({ items: [{ draft_id: D1, version: 6 }] })), /review_hash/);
  assert.match(parseAuthorize(authorizeBody({ items: [{ draft_id: D1, version: 6, review_hash: HASH }, { draft_id: D1, version: 6, review_hash: HASH }] })), /twice/);
  assert.match(parseAuthorize(authorizeBody({ destination_url: "https://www.logic-solar.com/blog/x" })), /origin/);
  assert.match(parseAuthorize(authorizeBody({ action: "approve", publish_at: "2026-10-20T15:00:00Z" })), /never publishes/);
  assert.match(parseAuthorize(authorizeBody({ instruction: { text: "Approve", channel: "slack", account_email: "t@x.co", executed_by: "x" } })), /channel/);
  assert.match(parseAuthorize(authorizeBody({ instruction: { text: " ", channel: "claude", account_email: "t@x.co", executed_by: "x" } })), /exact words/);
  const p = parseAuthorize(authorizeBody());
  assert.equal(typeof p, "object");
  assert.equal(p.destination_url, "https://www.logic-solar.com", "origin normalized");
  assert.equal(p.channel, "claude");
  assert.equal(p.instructed_at, null, "no invented time: the database stamps it");
  assert.deepEqual(p.source_ref, { executive_os_execution_id: "0f3c2b9e" });
});

test("v1 blog requests are normalized; Facebook and Business Profile items bind their Page / location", () => {
  const v1 = parseAuthorize(authorizeBody());
  assert.deepEqual(v1.items, [
    { channel: "blog", id: D1, version: 6, review_hash: HASH, destination: "https://www.logic-solar.com" },
    { channel: "blog", id: D2, version: 4, review_hash: HASH, destination: "https://www.logic-solar.com" },
  ]);
  const social = parseAuthorize(authorizeBody({
    destination_url: undefined,
    items: [
      { channel: "facebook", id: D1, review_hash: HASH, destination: "facebook:103977857788955" },
      { channel: "google_business", id: D2, review_hash: HASH, destination: "google_business:locations/3692365240387501506" },
    ],
  }));
  assert.equal(typeof social, "object");
  assert.deepEqual(social.items.map((i) => [i.channel, i.destination, "version" in i]), [
    ["facebook", "facebook:103977857788955", false],
    ["google_business", "google_business:locations/3692365240387501506", false],
  ]);
  assert.equal("destination_url" in social, false);
  assert.match(parseAuthorize(authorizeBody({ items: [{ channel: "instagram", id: D1, review_hash: HASH, destination: "x" }] })), /channel/);
  assert.match(parseAuthorize(authorizeBody({ items: [{ channel: "facebook", id: D1, review_hash: HASH }] })), /destination/);
  assert.match(parseAuthorize(authorizeBody({ destination_url: undefined, items: [{ channel: "blog", id: D1, version: 1, review_hash: HASH }] })), /destination/);
  const fifty = Array.from({ length: 51 }, (_, n) => ({ channel: "facebook", id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, review_hash: HASH, destination: "facebook:1" }));
  assert.match(parseAuthorize(authorizeBody({ items: fifty })), /1–50/);
});

test("batch passes a channel filter and refuses an unknown one", async () => {
  const s = fakeStore();
  assert.equal((await call(s, post({ mode: "batch", client_id: CLIENT, channel: "facebook" }))).status, 200);
  assert.deepEqual(s.calls.find(([n]) => n === "batch"), ["batch", CLIENT, "facebook"]);
  assert.equal((await call(fakeStore(), post({ mode: "batch", client_id: CLIENT, channel: "tiktok" }))).status, 400);
});

test("an invalid request records nothing", async () => {
  const s = fakeStore();
  const r = await call(s, post(authorizeBody({ items: [] })));
  assert.equal(r.status, 400);
  assert.ok(!s.calls.some(([n]) => n === "record"));
});

test("a recorded authorization executes once and reports the receipt", async () => {
  const s = fakeStore();
  const r = await call(s, post(authorizeBody()));
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.receipt.status, "executed");
  assert.equal(body.replayed, false);
  assert.deepEqual(s.calls.filter(([n]) => n === "record" || n === "execute").map(([n]) => n), ["record", "execute"]);
});

test("a retry of a finished operation is a replay and never executes again", async () => {
  for (const status of ["executed", "refused"]) {
    const s = fakeStore({ record: { data: { id: "rcpt-1", status, replayed: true }, error: null } });
    const r = await call(s, post(authorizeBody()));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).replayed, true);
    assert.ok(!s.calls.some(([n]) => n === "execute"), `no execute for a ${status} receipt`);
  }
});

test("refusals at recording map to honest statuses and record nothing", async () => {
  const cases = [
    ["42501", "not_authorized: x is not a Compass admin who can approve content", 403, "not_authorized"],
    ["42501", "policy_disallows: delegated publish is not enabled for this client", 403, "policy_disallows"],
    ["CD409", "operation_reused: operation exos-1 was used for a different request", 409, "operation_reused"],
    ["22023", "intent_mismatch: the instruction asks to publish; use approve_and_publish", 422, "intent_mismatch"],
  ];
  for (const [code, message, status, error] of cases) {
    const s = fakeStore({ record: { data: null, error: { code, message } } });
    const r = await call(s, post(authorizeBody()));
    assert.equal(r.status, status, message);
    const body = await r.json();
    assert.equal(body.error, error);
    assert.equal(body.recorded, false);
    assert.ok(!s.calls.some(([n]) => n === "execute"));
  }
});

test("a check that fails at execution rolls back and refuses the receipt with its reason", async () => {
  for (const reason of ["stale_version", "content_changed", "wrong_destination", "not_approved"]) {
    const message = `${reason}: "Blog A" changed; review it again`;
    const s = fakeStore({ execute: { data: null, error: { code: "23514", message } } });
    const r = await call(s, post(authorizeBody()));
    assert.equal(r.status, 422);
    const body = await r.json();
    assert.equal(body.error, reason);
    const refuse = s.calls.find(([n]) => n === "refuse");
    assert.deepEqual(refuse.slice(1, 3), ["rcpt-1", reason]);
  }
});

test("an unconfirmed outcome is reported as unknown, never as refused", async () => {
  // A PostgREST error without a SQLSTATE (gateway timeout, network) or a
  // thrown fetch: the transaction may have committed. Retry with the same
  // operation_id; the receipt makes it safe.
  let s = fakeStore({ execute: { data: null, error: { code: null, message: "upstream timeout" } } });
  let r = await call(s, post(authorizeBody()));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "outcome_unknown");
  assert.ok(!s.calls.some(([n]) => n === "refuse"), "an unknown outcome is never marked refused");

  s = fakeStore({ record: { data: null, error: { code: "PGRST000", message: "connection refused" } } });
  r = await call(s, post(authorizeBody()));
  assert.equal(r.status, 503);

  for (const o of [{ recordThrows: true }, { executeThrows: true }]) {
    s = fakeStore(o);
    r = await call(s, post(authorizeBody()));
    assert.equal(r.status, 503, JSON.stringify(o));
    assert.equal((await r.json()).error, "outcome_unknown");
    assert.ok(!s.calls.some(([n]) => n === "refuse"));
  }
});

test("status reads the receipt or says nothing was recorded", async () => {
  let r = await call(fakeStore(), post({ mode: "status", operation_id: "exos-0f3c2b9e-1111" }));
  assert.equal(r.status, 404);
  const receipt = { id: "rcpt-1", status: "executed", items_now: [{ draft_id: D1, publication: { state: "live", published_url: "https://www.logic-solar.com/blog/a/" } }] };
  r = await call(fakeStore({ status: { data: receipt, error: null } }), post({ mode: "status", operation_id: "exos-0f3c2b9e-1111" }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).receipt.items_now[0].publication.state, "live");
  r = await call(fakeStore(), post({ mode: "status" }));
  assert.equal(r.status, 400);
});
