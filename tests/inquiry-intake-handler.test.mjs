// inquiry-intake's handler (CRM Lite) over an in-memory store that keeps the
// database's rules that matter at this boundary: a source belongs to one
// client, a submission id is recorded once per source, contacts are matched
// within the client. The rules themselves run in Postgres
// (supabase/tests/sandbox/crm_lite.test.sql). Fixtures are fictional; nothing
// is sent anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInquiryIntake, cleanInquiry, tokensMatch, payloadHash } from "../supabase/functions/inquiry-intake/handler.ts";

const CLIENT_X = "00000000-0000-4000-8000-0000000000a1";
const CLIENT_Y = "00000000-0000-4000-8000-0000000000b1";
const TOKEN_X = "cit_fixture-token-x-not-real";
const TOKEN_Y = "cit_fixture-token-y-not-real";

function fakeStore(o = {}) {
  const s = {
    sources: {
      "x-website": { id: "src-x", client_id: CLIENT_X, enabled: true, secret_name: "CRM_INTAKE_X_WEBSITE", client_enabled: true },
      "y-website": { id: "src-y", client_id: CLIENT_Y, enabled: true, secret_name: "CRM_INTAKE_Y_WEBSITE", client_enabled: true },
      "no-token": { id: "src-n", client_id: CLIENT_X, enabled: true, secret_name: "CRM_INTAKE_NO_TOKEN", client_enabled: true },
      ...(o.sources ?? {}),
    },
    secrets: { CRM_INTAKE_X_WEBSITE: TOKEN_X, CRM_INTAKE_Y_WEBSITE: TOKEN_Y },
    inquiries: new Map(),
    contacts: [],
    calls: 0,
    down: o.down ?? false,
  };
  return {
    s,
    async source(key) { return s.sources[key] ?? null; },
    async secret(name) { return s.secrets[name] ?? null; },
    async ingest(p) {
      s.calls++;
      if (s.down) throw new Error("connection refused");
      const src = Object.values(s.sources).find((x) => x.id === p.source_id);
      const key = `${p.source_id}|${p.submission_id}`;
      if (s.inquiries.has(key)) return { duplicate: true, inquiry_id: s.inquiries.get(key).id };
      if (!src.enabled || !src.client_enabled) throw new Error("not_enabled: this inquiry source is disabled");
      let contact = s.contacts.find((c) => c.client_id === src.client_id && c.email === (p.email ?? "").toLowerCase());
      if (!contact) { contact = { id: `contact-${s.contacts.length + 1}`, client_id: src.client_id, email: (p.email ?? "").toLowerCase() }; s.contacts.push(contact); }
      const row = { id: `inq-${s.inquiries.size + 1}`, client_id: src.client_id, contact_id: contact.id, ...p };
      s.inquiries.set(key, row);
      return { duplicate: false, inquiry_id: row.id, contact_id: contact.id, jobs: o.jobs ?? [{ status: "blocked", block_reason: "sms_alerts_off" }] };
    },
  };
}

const valid = {
  submission_id: "3f1c2a8e-7c2d-4b8a-9a43-1e2f3a4b5c6d", name: "Pat Visitor", email: "Pat@Example.test", phone: "(618) 555-0142",
  location: "Edwardsville, IL", service_type: "Home Interiors", budget: "Not sure yet", message: "Please call me about our kitchen.",
  page_url: "https://www.example.test/contact/", submitted_at: "2026-10-11T15:00:00.000Z", email_status: "accepted", email_provider_id: "email-1",
};

function req(body, { key = "x-website", token = TOKEN_X, method = "POST", type = "application/json" } = {}) {
  const headers = { "content-type": type };
  if (key != null) headers["x-compass-source"] = key;
  if (token != null) headers.authorization = `Bearer ${token}`;
  return new Request("https://example-ref.supabase.co/functions/v1/inquiry-intake", {
    method, headers, body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(fn, r) {
  const res = await fn.handle(r);
  return { status: res.status, body: await res.json() };
}

test("inquiry-intake: unauthorized callers get the same 401 and nothing is written", async () => {
  const store = fakeStore();
  const fn = createInquiryIntake({ store });
  for (const r of [
    req(valid, { token: null }),
    req(valid, { token: "wrong" }),
    req(valid, { key: null }),
    req(valid, { key: "unknown-site" }),
    req(valid, { key: "no-token", token: "" }),
    req(valid, { key: "no-token", token: "anything" }),
    req(valid, { key: "Bad Key!" }),
  ]) {
    const r2 = await call(fn, r);
    assert.equal(r2.status, 401);
    assert.deepEqual(r2.body, { ok: false, error: "unauthorized" });
  }
  assert.equal(store.s.calls, 0);
});

test("inquiry-intake: a token for client Y's source cannot write into client X (cross-client)", async () => {
  const store = fakeStore();
  const fn = createInquiryIntake({ store });
  // Y's token presented with X's source key.
  assert.equal((await call(fn, req(valid, { key: "x-website", token: TOKEN_Y }))).status, 401);
  // X's token with X's key, but the body claims client Y: the client is the source's.
  const r = await call(fn, req({ ...valid, client_id: CLIENT_Y, clientId: CLIENT_Y }));
  assert.equal(r.status, 200);
  const saved = [...store.s.inquiries.values()][0];
  assert.equal(saved.client_id, CLIENT_X);
  assert.equal(saved.source_id, "src-x");
  assert.equal("client_id" in saved && saved.client_id !== CLIENT_X, false);
});

test("inquiry-intake: the same submission id twice is one inquiry", async () => {
  const store = fakeStore();
  const fn = createInquiryIntake({ store });
  const a = await call(fn, req(valid));
  const b = await call(fn, req(valid));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.duplicate, false);
  assert.equal(b.body.duplicate, true);
  assert.equal(a.body.inquiry_id, b.body.inquiry_id);
  assert.equal(store.s.inquiries.size, 1);
});

test("inquiry-intake: separate submissions from the same person are separate inquiries on one contact", async () => {
  const store = fakeStore();
  const fn = createInquiryIntake({ store });
  const a = await call(fn, req(valid));
  const b = await call(fn, req({ ...valid, submission_id: "7d1e9b20-0000-4000-8000-000000000002", message: "A second project." }));
  assert.notEqual(a.body.inquiry_id, b.body.inquiry_id);
  assert.equal(store.s.inquiries.size, 2);
  assert.equal(store.s.contacts.length, 1);
});

test("inquiry-intake: the same person at another client gets that client's own contact", async () => {
  const store = fakeStore();
  const fn = createInquiryIntake({ store });
  await call(fn, req(valid));
  await call(fn, req(valid, { key: "y-website", token: TOKEN_Y }));
  assert.equal(store.s.contacts.length, 2);
  assert.deepEqual(store.s.contacts.map((c) => c.client_id).sort(), [CLIENT_X, CLIENT_Y].sort());
});

test("inquiry-intake: validation refuses bad input before the database", async () => {
  const store = fakeStore();
  const fn = createInquiryIntake({ store });
  for (const [body, field] of [
    [{ ...valid, submission_id: "short" }, "submission_id"],
    [{ ...valid, submission_id: "has spaces in it" }, "submission_id"],
    [{ ...valid, name: "   " }, "name"],
    [{ ...valid, message: "  " }, "message"],
    [{ ...valid, email: "not-an-email" }, "email"],
    [{ ...valid, email: "", phone: "" }, "email_or_phone"],
    [{ ...valid, message: "x".repeat(10_001) }, "message"],
    [{ ...valid, email_status: "sent" }, "email_status"],
    [{ ...valid, submitted_at: "yesterday-ish" }, "submitted_at"],
  ]) {
    const r = await call(fn, req(body));
    assert.equal(r.status, 400, field);
    assert.equal(r.body.field, field);
  }
  assert.equal((await call(fn, req("{not json"))).status, 400);
  assert.equal((await call(fn, req(valid, { type: "text/plain" }))).status, 415);
  assert.equal((await call(fn, req(valid, { method: "GET" }))).status, 405);
  assert.equal((await call(fn, req({ ...valid, message: "x".repeat(40_000) }))).status, 413);
  assert.equal(store.s.calls, 0);
});

test("inquiry-intake: a disabled source or client is 403; a database outage is 503 (never a false 200)", async () => {
  const off = fakeStore({ sources: { "x-website": { id: "src-x", client_id: CLIENT_X, enabled: false, secret_name: "CRM_INTAKE_X_WEBSITE", client_enabled: true } } });
  assert.equal((await call(createInquiryIntake({ store: off }), req(valid))).status, 403);
  const down = fakeStore({ down: true });
  const r = await call(createInquiryIntake({ store: down }), req(valid));
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
});

test("inquiry-intake: recovery after an outage saves the inquiry once", async () => {
  const store = fakeStore({ down: true });
  const fn = createInquiryIntake({ store });
  assert.equal((await call(fn, req(valid))).status, 503);
  store.s.down = false;
  const ok = await call(fn, req(valid));
  const again = await call(fn, req(valid));
  assert.equal(ok.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(store.s.inquiries.size, 1);
});

test("inquiry-intake: queued alerts start the dispatcher; blocked ones do not", async () => {
  let kicks = 0;
  const blocked = createInquiryIntake({ store: fakeStore(), kick: async () => { kicks++; } });
  await call(blocked, req(valid));
  assert.equal(kicks, 0);
  const queued = createInquiryIntake({ store: fakeStore({ jobs: [{ status: "queued" }] }), kick: async () => { kicks++; } });
  await call(queued, req(valid));
  assert.equal(kicks, 1);
  // A failing kick never fails the save.
  const failing = createInquiryIntake({ store: fakeStore({ jobs: [{ status: "queued" }] }), kick: async () => { throw new Error("x"); } });
  assert.equal((await call(failing, req(valid))).status, 200);
});

test("inquiry-intake: logs never carry the visitor's details or the token", async () => {
  const lines = [];
  const fn = createInquiryIntake({ store: fakeStore(), log: (e, d) => lines.push(JSON.stringify({ e, ...d })) });
  await call(fn, req(valid));
  await call(fn, req(valid, { token: "wrong" }));
  const all = lines.join("\n");
  for (const secret of ["Pat", "example.test", "555-0142", "kitchen", TOKEN_X, "wrong"]) assert.ok(!all.includes(secret), secret);
});

test("inquiry-intake helpers: tokens compare by digest; the payload hash ignores the email outcome", async () => {
  assert.equal(await tokensMatch("a", "a"), true);
  assert.equal(await tokensMatch("a", "b"), false);
  assert.equal(await tokensMatch("", ""), false);
  const a = cleanInquiry(valid);
  const b = cleanInquiry({ ...valid, email_status: "failed", submitted_at: "2026-10-11T16:00:00Z" });
  assert.ok(a.ok && b.ok);
  assert.equal(await payloadHash(a.value), await payloadHash(b.value));
  assert.notEqual(await payloadHash(a.value), await payloadHash({ ...a.value, message: "changed" }));
});
