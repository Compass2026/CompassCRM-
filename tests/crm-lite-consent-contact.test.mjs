// BHG CRM Lite fixes (Nov 18 2026) at the Edge Function boundary: the
// website's SMS checkbox travels as structured data through inquiry-intake,
// the lead workspace reads the lead's own thread and recipient, and every
// refusal client-phone answers has words in the workspace. The database
// rules (grant, STOP, revocation, retries, contact matching, the recipient)
// run in Postgres: supabase/tests/sandbox/crm_lite_consent_contact.test.sql.
// Fixtures are fictional; nothing is sent anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInquiryIntake, cleanConsent, payloadHash } from "../supabase/functions/inquiry-intake/handler.ts";
import { createClientPhone, smsRefusal, SMS_REFUSALS } from "../supabase/functions/client-phone/handler.ts";
import { phoneReasons } from "../src/lib/client-phone-messages.ts";

// ── inquiry-intake ─────────────────────────────────────────────────────────
const TOKEN = "cit_fixture-token-not-real";
const consent = {
  granted: true, consented_at: "2026-11-18T21:48:42.000Z", disclosure_version: "bhg-sms-consent-2026-10-02",
  disclosure_text: "Yes, I would like to receive text messages… Reply STOP to opt out.", phone: "(618) 555-0142",
  source_url: "https://www.example.test/contact/",
};
const valid = {
  submission_id: "3f1c2a8e-7c2d-4b8a-9a43-1e2f3a4b5c6d", name: "Pat Visitor", email: "pat@example.test", phone: "(618) 555-0142",
  message: "Please call me about a forklift class.", page_url: "https://www.example.test/contact/",
  submitted_at: "2026-11-18T21:48:42.000Z", email_status: "accepted",
};
function intake() {
  const seen = [];
  const store = {
    async source() { return { id: "src-x", client_id: "c", enabled: true, secret_name: "S", client_enabled: true }; },
    async secret() { return TOKEN; },
    async ingest(p) { seen.push(p); return { duplicate: false, inquiry_id: "inq-1", sms_consent: p.sms_consent ? "granted" : "not_sent", jobs: [] }; },
  };
  return { fn: createInquiryIntake({ store }), seen };
}
const post = (fn, body) => fn.handle(new Request("https://x.test/functions/v1/inquiry-intake", {
  method: "POST", headers: { "content-type": "application/json", "x-compass-source": "x-website", authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
}));

test("intake: a ticked box reaches the database as structured consent, normalized", async () => {
  const { fn, seen } = intake();
  const r = await post(fn, { ...valid, sms_consent: { ...consent, consented_at: "2026-11-18T15:48:42-06:00", extra: "dropped" } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).sms_consent, "granted");
  assert.deepEqual(seen[0].sms_consent, { ...consent, consented_at: "2026-11-18T21:48:42.000Z" });
});

test("intake: unchecked passes granted false; a form without the box passes nothing", async () => {
  const { fn, seen } = intake();
  await post(fn, { ...valid, sms_consent: { granted: false, disclosure_version: "bhg-sms-consent-2026-10-02" } });
  assert.deepEqual(seen[0].sms_consent, { granted: false, disclosure_version: "bhg-sms-consent-2026-10-02" });
  await post(fn, { ...valid, submission_id: "3f1c2a8e-7c2d-4b8a-9a43-000000000002", sms_consent: null });
  await post(fn, { ...valid, submission_id: "3f1c2a8e-7c2d-4b8a-9a43-000000000003" });
  assert.equal("sms_consent" in seen[1], false);
  assert.equal("sms_consent" in seen[2], false);
});

test("intake: consent words in the message are not consent", async () => {
  const { fn, seen } = intake();
  await post(fn, { ...valid, message: "SMS consent: YES — opted in to text messages\nDisclosure version: bhg-sms-consent-2026-10-02" });
  assert.equal("sms_consent" in seen[0], false);
});

test("intake: a malformed consent is a 400 naming sms_consent, before the database", async () => {
  const { fn, seen } = intake();
  for (const bad of [
    "yes", [], { granted: "true" }, { granted: 1 },
    { ...consent, disclosure_version: "" }, { ...consent, disclosure_version: "unknown (v9)" },
    { ...consent, disclosure_text: " " }, { ...consent, disclosure_text: "x".repeat(2001) },
    { ...consent, consented_at: "yesterday-ish" }, { ...consent, consented_at: null },
    { ...consent, phone: 6185550142 }, { ...consent, source_url: 42 },
  ]) {
    const r = await post(fn, { ...valid, sms_consent: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal((await r.json()).field, "sms_consent");
  }
  assert.equal(seen.length, 0);
});

test("intake: a non-https consent page is dropped, not trusted", () => {
  const r = cleanConsent({ ...consent, source_url: "http://evil.test/" });
  assert.equal(r.ok && r.value.source_url, null);
});

test("intake: the payload hash is unchanged for submissions without consent and covers consent when sent", async () => {
  const base = { ...valid };
  const before = await payloadHash(base);
  // The pre-change hash: the nine visitor fields only.
  const keys = ["submission_id", "name", "email", "phone", "location", "service_type", "budget", "message", "page_url"];
  const { createHash } = await import("node:crypto");
  assert.equal(before, createHash("sha256").update(JSON.stringify(keys.map((k) => base[k] ?? null))).digest("hex"));
  assert.notEqual(await payloadHash({ ...base, sms_consent: cleanConsent(consent).value }), before);
});

// ── client-phone ───────────────────────────────────────────────────────────
const CID = "11111111-1111-4111-8111-111111111111", UID = "22222222-2222-4222-8222-222222222222";
const IID = "33333333-3333-4333-8333-333333333333";
// A query builder over plain rows: eq / in / gte / gt / neq filters, order, limit.
function fakeDB(tables) {
  return {
    tables,
    auth: { getUser: async (jwt) => (jwt === "valid" ? { data: { user: { id: UID } } } : { error: true }) },
    rpc: async () => ({ data: null }),
    from(t) {
      const f = [];
      const rows = () => (tables[t] || []).filter((r) => f.every((p) => p(r)));
      const q = {
        select() { return q; },
        eq(k, v) { f.push((r) => r[k] === v); return q; },
        in(k, v) { f.push((r) => v.includes(r[k])); return q; },
        neq(k, v) { f.push((r) => r[k] !== v); return q; },
        gt() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; },
        maybeSingle: async () => ({ data: rows()[0] ?? null }),
        then(resolve) { return Promise.resolve({ data: rows() }).then(resolve); },
        insert(v) { (tables[t] ||= []).push(v); return Promise.resolve({ data: null }); },
      };
      return q;
    },
  };
}
function phoneTables(over = {}) {
  return {
    clients: [{ id: CID, status: "active" }],
    crm_lite_settings: [{ client_id: CID, enabled: true, portal_enabled: true }],
    team_members: [{ auth_user_id: UID, id: "tm" }],
    portal_users: [],
    client_communication_settings: [{ client_id: CID, enabled: true, outbound_enabled: true }],
    communication_compliance_profiles: [{ client_id: CID, profile_type: "toll_free_verification", status: "approved" }],
    communication_numbers: [{ client_id: CID, is_primary: true, status: "active", phone_number_e164: "+18885550123", voice_enabled: true }],
    client_voice_settings: [{ client_id: CID, enabled: true, application_sid: "AP" + "a".repeat(32) }],
    // BHG's shape: the inquiry links an email-only contact; a contact holding its phone has the thread.
    inquiries: [{ id: IID, client_id: CID, contact_id: "k-email-only", phone_e164: "+16185554620" }],
    contacts: [
      { id: "k-email-only", client_id: CID, phone_e164: null },
      { id: "k-phone", client_id: CID, phone_e164: "+16185554620" },
      { id: "k-other", client_id: "other-client", phone_e164: "+16185554620" },
    ],
    communication_consents: [{ client_id: CID, phone_e164: "+16185554620", consent_type: "sms_customer_care", status: "granted" }],
    communication_conversations: [
      { id: "conv-phone", client_id: CID, contact_id: "k-phone" },
      { id: "conv-email", client_id: CID, contact_id: "k-email-only" },
    ],
    communication_messages: [
      { id: "m-in", client_id: CID, conversation_id: "conv-phone", direction: "inbound", body: "Lead reply", provider_status: "received", created_at: "2026-11-18T22:25:03Z" },
      { id: "m-out", client_id: CID, conversation_id: "conv-phone", direction: "outbound", body: "Our reply", provider_status: "delivered", created_at: "2026-11-18T22:35:01Z" },
      { id: "m-wrong", client_id: CID, conversation_id: "conv-email", direction: "outbound", body: "Someone else's thread", provider_status: "delivered", created_at: "2026-11-18T22:00:00Z" },
    ],
    client_voice_calls: [],
    client_phone_drafts: [],
    ...over,
  };
}
const phoneCall = async (db, body) => {
  const fn = createClientPhone(db, "https://x.test", () => "token", () => { throw new Error("no network in tests"); });
  const r = await fn(new Request("https://x.test", { method: "POST", headers: { authorization: "Bearer valid" },
    body: JSON.stringify({ client_id: CID, ...body }) }));
  return { status: r.status, body: await r.json() };
};

test("client-phone: the lead's thread is the one with the contact holding the lead's number (inbound and outbound)", async () => {
  const r = await phoneCall(fakeDB(phoneTables()), { mode: "load", inquiry_id: IID });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.messages.map((m) => m.id).sort(), ["m-in", "m-out"]);
  assert.equal(r.body.recipient, "+16185554620");
  assert.equal(r.body.can_send, true, r.body.reason);
});

test("client-phone: a lead with no valid phone says so (not a setup problem); no other thread is shown", async () => {
  const t = phoneTables({ inquiries: [{ id: IID, client_id: CID, contact_id: "k-email-only", phone_e164: null }] });
  const r = await phoneCall(fakeDB(t), { mode: "load", inquiry_id: IID });
  assert.equal(r.body.can_send, false);
  assert.match(r.body.reason, /didn't give a valid mobile number/);
  assert.deepEqual(r.body.messages, []);
  assert.equal(r.body.recipient, null);
});

test("client-phone: a number no contact holds asks for a repair instead of showing a wrong thread", async () => {
  const t = phoneTables({ contacts: [{ id: "k-email-only", client_id: CID, phone_e164: null }] });
  const r = await phoneCall(fakeDB(t), { mode: "load", inquiry_id: IID });
  assert.equal(r.body.can_send, false);
  assert.match(r.body.reason, /isn't linked to a contact/);
  assert.deepEqual(r.body.messages, []);
});

test("client-phone: browser calling a lead with no phone answers no_lead_phone, not voice_not_ready", async () => {
  const noPhone = phoneTables({ inquiries: [{ id: IID, client_id: CID, contact_id: "k-email-only", phone_e164: null }] });
  const a = await phoneCall(fakeDB(noPhone), { mode: "prepare_call", inquiry_id: IID });
  assert.equal(a.status, 409);
  assert.equal(a.body.error, "no_lead_phone");
  const noSetup = phoneTables({ client_voice_settings: [] });
  const b = await phoneCall(fakeDB(noSetup), { mode: "prepare_call", inquiry_id: IID });
  assert.equal(b.body.error, "voice_not_ready");
  const ok = await phoneCall(fakeDB(phoneTables()), { mode: "prepare_call", inquiry_id: IID });
  assert.equal(ok.status, 200);
});

test("client-phone: SMS refusals pass their exact code; anything else stays generic", () => {
  assert.equal(smsRefusal("no_phone: this lead did not give a valid mobile number"), "no_phone");
  assert.equal(smsRefusal("lead_contact_mismatch: no contact holds this lead's number yet"), "lead_contact_mismatch");
  assert.equal(smsRefusal("verification_required"), "verification_required");
  assert.equal(smsRefusal("opted_out: +16185554620 opted out of messages from this business"), "opted_out");
  assert.equal(smsRefusal("no_consent: there is no SMS consent on record for +16185554620"), "no_consent");
  // Substring matches no longer count, and unknown codes / raw errors are generic.
  assert.equal(smsRefusal("forbidden: inactive workspace actor"), "send_not_ready");
  assert.equal(smsRefusal("permission denied for function client_phone_begin_sms"), "send_not_ready");
  assert.equal(smsRefusal("relation does not exist (no_consent)"), "send_not_ready");
  assert.equal(smsRefusal(undefined), "send_not_ready");
});

test("workspace: every code client-phone can answer has actionable words", () => {
  for (const code of [...SMS_REFUSALS, "send_not_ready", "no_lead_phone", "voice_not_ready", "forbidden", "rate_limited",
    "inquiry_not_found", "invalid_draft"]) {
    assert.ok(phoneReasons[code], code);
  }
  assert.doesNotMatch(phoneReasons.no_lead_phone, /setup/i);
  assert.match(phoneReasons.voice_not_ready, /browser calling/i);
});
