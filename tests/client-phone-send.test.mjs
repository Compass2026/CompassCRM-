// client-phone's Send (supabase/functions/client-phone/handler.ts): one press
// saves the text and sends it, a request id never sends twice, failures keep
// the draft, and an uncertain send is checked with Twilio before any retry.
// The real handler runs over an in-memory database whose client_phone_begin_sms
// keeps the rules that matter here (dedupe by request id, the saved draft is
// the text sent, the uncertain-send block); the database function itself is
// tested in supabase/tests/sandbox/crm_lite_consent_contact.test.sql and
// tests/client-phone-workspace.test.mjs. Twilio is a fake; nothing is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClientPhone, RECONCILE_AFTER_MS } from "../supabase/functions/client-phone/handler.ts";

const CID = "11111111-1111-4111-8111-111111111111", UID = "22222222-2222-4222-8222-222222222222";
const IID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "AC" + "a".repeat(32), SERVICE = "MG" + "b".repeat(32);
const LEAD = "+16185550142", LINE = "+18885550123";
const rid = (n) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;

function world(o = {}) {
  const t = {
    clients: [{ id: CID, status: "active" }],
    crm_lite_settings: [{ client_id: CID, enabled: true, portal_enabled: false }],
    team_members: [{ auth_user_id: UID, id: "tm" }],
    portal_users: [],
    inquiries: [{ id: IID, client_id: CID, contact_id: "k", phone_e164: LEAD }],
    contacts: [{ id: "k", client_id: CID, phone_e164: LEAD }],
    client_communication_settings: [{ client_id: CID, enabled: true, outbound_enabled: true }],
    communication_compliance_profiles: [{ client_id: CID, profile_type: "toll_free_verification", status: "approved" }],
    communication_numbers: [{ client_id: CID, is_primary: true, status: "active", phone_number_e164: LINE, voice_enabled: true }],
    communication_accounts: [{ client_id: CID, provider: "twilio", status: "active", provider_account_sid: ACCOUNT }],
    communication_consents: [{ client_id: CID, phone_e164: LEAD, consent_type: "sms_customer_care", status: o.consent ?? "granted" }],
    communication_conversations: [{ id: "conv", client_id: CID, contact_id: "k" }],
    communication_messages: [],
    client_phone_drafts: [],
    client_voice_settings: [],
    client_voice_calls: [],
  };
  const calls = { rpc: [], twilioPosts: [], twilioLists: 0 };
  let n = 0;
  const rpcs = {
    client_phone_begin_sms({ p }) {
      const dup = t.communication_messages.find((m) => m.request_id === p.request_id);
      if (dup) return { data: { duplicate: true, message_id: dup.id } };
      const draft = t.client_phone_drafts.find((d) => d.client_id === p.client_id && d.inquiry_id === p.inquiry_id
        && d.actor_id === p.actor_id && d.revision === p.request_id);
      if (!draft) return { error: { message: "save_draft_first" } };
      if (t.communication_messages.some((m) => m.inquiry_id === p.inquiry_id && m.provider_status === "pending" && !m.provider_message_sid))
        return { error: { message: "send_uncertain_refresh_first" } };
      const c = t.communication_consents.find((x) => x.phone_e164 === LEAD);
      if (c?.status === "opted_out") return { error: { message: `opted_out: ${LEAD} opted out of messages from this business` } };
      if (c?.status !== "granted") return { error: { message: `no_consent: there is no SMS consent on record for ${LEAD}` } };
      const m = { id: `msg-${++n}`, request_id: p.request_id, client_id: p.client_id, inquiry_id: p.inquiry_id, client_actor_id: p.actor_id,
        conversation_id: "conv", direction: "outbound", body: draft.body.trim(), to_e164: LEAD, from_e164: LINE,
        provider_status: "pending", provider_message_sid: null, error_code: null, created_at: new Date().toISOString() };
      t.communication_messages.push(m);
      return { data: { duplicate: false, message_id: m.id, to: LEAD, from: LINE, messaging_service_sid: SERVICE, account_sid: ACCOUNT, body: m.body } };
    },
    communication_subaccount_secrets: () => ({ data: { api_key: "SK" + "c".repeat(32), api_secret: "fixture-secret" } }),
    communication_mark_sent({ p }) {
      const m = t.communication_messages.find((x) => x.id === p.message_id);
      if (p.provider_message_sid) { m.provider_message_sid = p.provider_message_sid; m.provider_status = p.provider_status || "queued"; }
      else { m.provider_status = "failed"; m.error_code = p.error_code; }
      return { data: { result: "applied" } };
    },
  };
  const db = {
    auth: { getUser: async (jwt) => (jwt === "valid" ? { data: { user: { id: UID } } } : { error: true }) },
    rpc: async (name, args) => { calls.rpc.push(name); return rpcs[name] ? rpcs[name](args) : { data: null }; },
    from(table) {
      const f = [];
      let op = "select", payload = null;
      const rows = () => (t[table] ||= []).filter((r) => f.every((p) => p(r)));
      const run = () => {
        if (op === "delete") { t[table] = t[table].filter((r) => !f.every((p) => p(r))); return { data: null }; }
        if (op === "upsert") {
          const keys = ["client_id", "inquiry_id", "actor_id"];
          const i = t[table].findIndex((r) => keys.every((k) => r[k] === payload[k]));
          if (i >= 0) t[table][i] = { ...t[table][i], ...payload }; else t[table].push({ ...payload });
          return { data: null };
        }
        return { data: rows() };
      };
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, gt() { return q; }, gte() { return q; },
        eq(k, v) { f.push((r) => r[k] === v); return q; },
        is(k, v) { f.push((r) => (r[k] ?? null) === v); return q; },
        in(k, v) { f.push((r) => v.includes(r[k])); return q; },
        neq(k, v) { f.push((r) => r[k] !== v); return q; },
        delete() { op = "delete"; return q; },
        upsert(v) { op = "upsert"; payload = v; return q; },
        maybeSingle: async () => ({ data: rows()[0] ?? null }),
        then(resolve) { return Promise.resolve(run()).then(resolve); },
      };
      return q;
    },
  };
  // Fake Twilio: o.post decides each send; o.list is what a listing shows.
  const request = async (url, init) => {
    if (init?.method === "POST" && String(url).endsWith("/Messages.json")) {
      const form = new URLSearchParams(init.body);
      calls.twilioPosts.push({ to: form.get("To"), body: form.get("Body") });
      const r = (o.post ?? (() => "ok"))(calls.twilioPosts.length);
      if (r === "network") throw new TypeError("fetch failed");
      if (r === "refused") return new Response(JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number" }), { status: 400 });
      if (r === "5xx") return new Response(JSON.stringify({ message: "upstream" }), { status: 503 });
      return new Response(JSON.stringify({ sid: "SM" + String(calls.twilioPosts.length).padStart(32, "0"), status: "queued" }), { status: 201 });
    }
    if (init?.method === "GET" && String(url).includes("/Messages.json?")) {
      calls.twilioLists++;
      return new Response(JSON.stringify({ messages: o.list ? o.list(t) : [], next_page_uri: null }), { status: 200 });
    }
    throw new Error("unexpected request " + url);
  };
  const fn = createClientPhone(db, "https://x.test", () => "token", request);
  const call = async (body) => {
    const r = await fn(new Request("https://x.test", { method: "POST", headers: { authorization: "Bearer valid" },
      body: JSON.stringify({ client_id: CID, inquiry_id: IID, ...body }) }));
    return { status: r.status, body: await r.json() };
  };
  const age = (ms) => { for (const m of t.communication_messages) m.created_at = new Date(Date.now() - ms).toISOString(); };
  return { t, calls, call, age };
}

test("send: one press sends the typed text with no separate save, and clears the saved draft", async () => {
  const w = world();
  const r = await w.call({ mode: "send", body: "  On our way at 9.  ", request_id: rid(1) });
  assert.equal(r.status, 200);
  assert.equal(r.body.send.state, "accepted");
  assert.deepEqual(w.calls.twilioPosts, [{ to: LEAD, body: "On our way at 9." }]);
  assert.equal(w.t.communication_messages[0].request_id, rid(1));
  assert.ok(w.t.communication_messages[0].provider_message_sid);
  assert.equal(w.t.client_phone_drafts.length, 0, "the text that went is not left as a draft");
  assert.equal(w.calls.rpc.includes("client_phone_begin_sms"), true);
});

test("send: the same request id again (a double press or a retried request) never sends a second text", async () => {
  const w = world();
  const [a, b] = await Promise.all([
    w.call({ mode: "send", body: "Hello", request_id: rid(2) }),
    w.call({ mode: "send", body: "Hello", request_id: rid(2) }),
  ]);
  const again = await w.call({ mode: "send", body: "Hello", request_id: rid(2) });
  assert.equal(w.calls.twilioPosts.length, 1);
  assert.equal(w.t.communication_messages.length, 1);
  for (const r of [a, b]) assert.ok(["accepted", "uncertain"].includes(r.body.send.state), JSON.stringify(r.body.send));
  assert.equal(again.body.send.state, "accepted");
});

test("send: an empty or too-long text is refused before anything is saved or reserved", async () => {
  const w = world();
  assert.equal((await w.call({ mode: "send", body: "   ", request_id: rid(3) })).body.error, "empty");
  assert.equal((await w.call({ mode: "send", body: "x".repeat(1601), request_id: rid(3) })).body.error, "too_long");
  assert.equal((await w.call({ mode: "send", body: "Hi", request_id: "not-a-uuid" })).body.error, "invalid_request");
  assert.equal(w.t.client_phone_drafts.length, 0);
  assert.equal(w.calls.twilioPosts.length, 0);
});

test("send: consent and STOP still refuse, with their own codes, and nothing reaches Twilio", async () => {
  for (const [consent, code] of [["revoked", "no_consent"], ["opted_out", "opted_out"]]) {
    const w = world({ consent });
    const r = await w.call({ mode: "send", body: "Hello", request_id: rid(4) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, code);
    assert.equal(w.calls.twilioPosts.length, 0);
    assert.equal(w.t.client_phone_drafts[0]?.body, "Hello", "the text is kept as the draft");
  }
});

test("send: a carrier refusal is a failure that keeps the draft; a new press (new id) can send again", async () => {
  const w = world({ post: (n) => (n === 1 ? "refused" : "ok") });
  const r = await w.call({ mode: "send", body: "Hello", request_id: rid(5) });
  assert.equal(r.body.send.state, "failed");
  assert.equal(r.body.send.code, "provider_refused");
  assert.equal(w.t.communication_messages[0].provider_status, "failed");
  assert.equal(w.t.client_phone_drafts[0].body, "Hello");
  const same = await w.call({ mode: "send", body: "Hello", request_id: rid(5) });
  assert.equal(same.body.send.state, "failed", "the refused press is not sent again");
  assert.equal(w.calls.twilioPosts.length, 1);
  const retry = await w.call({ mode: "send", body: "Hello", request_id: rid(6) });
  assert.equal(retry.body.send.state, "accepted");
  assert.equal(w.calls.twilioPosts.length, 2);
});

test("send: an uncertain send is not resent; asking again too soon only reports it", async () => {
  for (const post of ["5xx", "network"]) {
    const w = world({ post: () => post });
    const r = await w.call({ mode: "send", body: "Hello", request_id: rid(7) });
    assert.equal(r.body.send.state, "uncertain", post);
    const soon = await w.call({ mode: "send", body: "Hello", request_id: rid(7) });
    assert.equal(soon.body.send.state, "uncertain");
    assert.equal(w.calls.twilioLists, 0, "a send that may still be in flight is not judged");
    const other = await w.call({ mode: "send", body: "Something else", request_id: rid(8) });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, "send_uncertain_refresh_first", "a new text waits for the open one");
    assert.equal(w.calls.twilioPosts.length, 1);
  }
});

test("send: once old enough, an uncertain send Twilio has is adopted (accepted, no second text)", async () => {
  const w = world({ post: () => "5xx", list: (t) => [{ sid: "SM" + "f".repeat(32), body: "Hello", status: "delivered",
    date_created: new Date(Date.parse(t.communication_messages[0].created_at) + 1000).toUTCString() }] });
  await w.call({ mode: "send", body: "Hello", request_id: rid(9) });
  w.age(RECONCILE_AFTER_MS + 1000);
  const r = await w.call({ mode: "send", body: "Hello", request_id: rid(9) });
  assert.equal(r.body.send.state, "accepted");
  assert.equal(w.t.communication_messages[0].provider_message_sid, "SM" + "f".repeat(32));
  assert.equal(w.calls.twilioPosts.length, 1);
  assert.equal(w.t.client_phone_drafts.length, 0);
});

test("send: once old enough, an uncertain send Twilio never got is marked not sent, and only a new press sends", async () => {
  const w = world({ post: (n) => (n === 1 ? "network" : "ok"), list: () => [] });
  await w.call({ mode: "send", body: "Hello", request_id: rid(10) });
  w.age(RECONCILE_AFTER_MS + 1000);
  const checked = await w.call({ mode: "send", body: "Hello", request_id: rid(10) });
  assert.equal(checked.body.send.state, "failed");
  assert.equal(checked.body.send.code, "not_sent");
  assert.equal(w.t.communication_messages[0].error_code, "not_sent");
  assert.equal(w.calls.twilioPosts.length, 1, "checking never sends");
  const retry = await w.call({ mode: "send", body: "Hello", request_id: rid(11) });
  assert.equal(retry.body.send.state, "accepted");
  assert.equal(w.calls.twilioPosts.length, 2);
});

test("send: a new press first resolves an old uncertain send of the same lead", async () => {
  const w = world({ post: (n) => (n === 1 ? "5xx" : "ok"), list: () => [] });
  await w.call({ mode: "send", body: "First", request_id: rid(12) });
  w.age(RECONCILE_AFTER_MS + 1000);
  const r = await w.call({ mode: "send", body: "Second", request_id: rid(13) });
  assert.equal(r.body.send.state, "accepted");
  assert.deepEqual(w.t.communication_messages.map((m) => [m.body, m.provider_status]), [["First", "failed"], ["Second", "queued"]]);
});

test("send: a request id belonging to someone else's press is refused, not reported", async () => {
  const w = world();
  w.t.communication_messages.push({ id: "other", request_id: rid(14), client_id: CID, inquiry_id: IID, client_actor_id: "someone-else",
    provider_status: "delivered", provider_message_sid: "SM" + "e".repeat(32), body: "x", to_e164: LEAD, from_e164: LINE,
    created_at: new Date().toISOString() });
  const r = await w.call({ mode: "send", body: "Hello", request_id: rid(14) });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "invalid_request");
  assert.equal(w.calls.twilioPosts.length, 0);
});

test("autosave: keeps the draft quietly and never sends", async () => {
  const w = world();
  const r = await w.call({ mode: "autosave", body: "Half a thought" });
  assert.deepEqual(r.body, { saved: true });
  assert.equal(w.t.client_phone_drafts[0].body, "Half a thought");
  assert.equal(w.calls.twilioPosts.length, 0);
  assert.equal(w.calls.rpc.includes("client_phone_begin_sms"), false);
});
