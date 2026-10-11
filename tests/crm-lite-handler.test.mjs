// crm-lite's handler (CRM Lite alerts) over an in-memory outbox that keeps
// the database's claim / result rules, and a fake Twilio. The gates
// themselves (consent, sender approval, the switch, the delivery test, STOP,
// freshness) are the database's: supabase/tests/sandbox/crm_lite.test.sql.
// Here: who may call, what reaches Twilio, and that an unknown outcome is
// never resent blind. Fictional numbers; nothing reaches Twilio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCrmLite, classifySendError, findSent, listingCovers } from "../supabase/functions/crm-lite/handler.ts";
import { ProviderError } from "../supabase/functions/_shared/communications/provider.ts";

const SENDER = "AC" + "c".repeat(32);
const BASE = "https://example-ref.supabase.co/functions/v1/twilio-webhook";
const ADMIN = "00000000-0000-4000-8000-00000000aa01";
const MEMBER = "00000000-0000-4000-8000-00000000aa02";
const SOURCE = "00000000-0000-4000-8000-0000000000f1";
const sid = (n) => "SM" + String(n).padStart(32, "0");
const BODY = "Compass Marketing: Example Interiors has a new website inquiry. Review it: https://crm.example.test/portal/inquiries/1 Reply STOP to opt out or HELP for help.";

function fakeStore(o = {}) {
  const s = {
    secrets: {
      SYNC_CRON_SECRET: "cron-secret",
      [`TWILIO_SUB_${SENDER}_API_KEY`]: "SK" + "k".repeat(32), [`TWILIO_SUB_${SENDER}_API_SECRET`]: "key-secret-not-real",
      ...(o.secrets ?? {}),
    },
    jobs: new Map((o.jobs ?? []).map((j) => [j.id, { attempts: 0, max_attempts: 3, ...j }])),
    results: [],
    vaultWrites: [],
    issued: [],
  };
  const claimed = (j) => ({ job_id: j.id, attempt: j.attempts, to: j.to, from: "+18885550199", body: j.body, account_sid: SENDER,
    messaging_service_sid: null, since: j.since ?? new Date(Date.now() - 60_000).toISOString() });
  return {
    s,
    async secret(name) { return s.secrets[name] ?? null; },
    async setSecret(name, value) { s.vaultWrites.push({ name, value }); s.secrets[name] = value; },
    async subaccountSecrets(acct) {
      return { accountSid: acct, keySid: s.secrets[`TWILIO_SUB_${acct}_API_KEY`] ?? null, keySecret: s.secrets[`TWILIO_SUB_${acct}_API_SECRET`] ?? null,
        authToken: null, names: {}, authTokenFoundAs: null, otherAuthTokenAccounts: [] };
    },
    async caller(jwt) {
      return ({ "jwt-admin": { member: ADMIN, role: "admin" }, "jwt-member": { member: MEMBER, role: "member" },
        "jwt-stranger": { member: null, role: null } })[jwt] ?? "none";
    },
    async source(id) { return id === SOURCE ? { id, secret_name: "CRM_INTAKE_EXAMPLE_WEBSITE" } : null; },
    async recordTokenIssued(id, actor) { s.issued.push({ id, actor }); return { source_id: id }; },
    // Only queued jobs are claimed, each moved to 'sending' first.
    async claim(limit) {
      const out = [];
      for (const j of s.jobs.values()) {
        if (out.length >= limit || j.status !== "queued") continue;
        j.status = "sending"; j.attempts++;
        out.push(claimed(j));
      }
      return out;
    },
    async claimUnknown(limit) {
      return [...s.jobs.values()].filter((j) => j.status === "unknown").slice(0, limit).map(claimed);
    },
    async result(p) {
      s.results.push(p);
      const j = s.jobs.get(p.job_id);
      if (p.outcome === "accepted" || p.outcome === "found") { j.status = "sent"; j.sid = p.message_sid; }
      else if (p.outcome === "rejected") j.status = "failed";
      else if (p.outcome === "unknown") j.status = "unknown";
      else j.status = j.attempts >= j.max_attempts ? "failed" : "queued";
      return { job_id: j.id, status: j.status };
    },
    async beginTest(p) {
      if (o.testBlocked) throw new Error("blocked: consent_incomplete");
      const id = "job-test";
      if (!s.jobs.has(id)) s.jobs.set(id, { id, status: "queued", attempts: 0, max_attempts: 1, to: "+16185550100", body: BODY, request: p.request_id });
      return { duplicate: false, job_id: id };
    },
    async job(id) { const j = s.jobs.get(id); return j ? { status: j.status, provider_status: null } : null; },
  };
}

function fakeTwilio(o = {}) {
  const t = { sends: [], lists: [] };
  return {
    t,
    async sendMessage(cred, opts) {
      t.sends.push({ cred, opts });
      if (o.sendError) throw o.sendError;
      return { sid: sid(t.sends.length), status: "queued", errorCode: null, errorMessage: null };
    },
    async listMessages(cred, opts) {
      t.lists.push({ cred, opts });
      if (o.listError) throw o.listError;
      return o.listing ?? { messages: [], complete: true };
    },
  };
}

const job = (id, extra = {}) => ({ id, status: "queued", to: "+16185550100", body: BODY, ...extra });

function req(body, headers = {}) {
  return new Request("https://example-ref.supabase.co/functions/v1/crm-lite", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
const cron = { "x-cron-secret": "cron-secret" };
const as = (jwt) => ({ Authorization: `Bearer ${jwt}` });
async function call(fn, r) { const res = await fn.handle(r); return { status: res.status, body: await res.json() }; }
const make = (store, twilio) => createCrmLite({ store, provider: twilio, webhookBase: async () => BASE });

test("crm-lite: version is open; everything else needs the cron secret or a teammate", async () => {
  const fn = make(fakeStore(), fakeTwilio());
  assert.equal((await call(fn, req({ mode: "version" }))).status, 200);
  assert.equal((await call(fn, req({ mode: "dispatch" }))).status, 401);
  assert.equal((await call(fn, req({ mode: "dispatch" }, { "x-cron-secret": "wrong" }))).status, 403);
  assert.equal((await call(fn, req({ mode: "dispatch" }, as("jwt-stranger")))).status, 403);
  assert.equal((await call(fn, req({ mode: "dispatch" }, cron))).status, 200);
  assert.equal((await call(fn, req({ mode: "dispatch" }, as("jwt-member")))).status, 200);
});

test("crm-lite: with no queued job (every gate closed), nothing reaches Twilio", async () => {
  const twilio = fakeTwilio();
  const store = fakeStore({ jobs: [job("j1", { status: "blocked" }), job("j2", { status: "failed" })] });
  const r = await call(make(store, twilio), req({ mode: "dispatch" }, cron));
  assert.equal(r.status, 200);
  assert.equal(twilio.t.sends.length, 0);
  assert.equal(twilio.t.lists.length, 0);
});

test("crm-lite: a queued alert is sent once, from the sender number, with its status callback", async () => {
  const twilio = fakeTwilio();
  const store = fakeStore({ jobs: [job("j1")] });
  const fn = make(store, twilio);
  await call(fn, req({ mode: "dispatch" }, cron));
  await call(fn, req({ mode: "dispatch" }, cron));
  assert.equal(twilio.t.sends.length, 1);
  const { cred, opts } = twilio.t.sends[0];
  assert.equal(cred.accountSid, SENDER);
  assert.equal(opts.from, "+18885550199");
  assert.equal(opts.body, BODY);
  assert.equal(opts.statusCallbackUrl, `${BASE}/notifications/status?j=j1`);
  assert.equal(store.s.jobs.get("j1").status, "sent");
});

test("crm-lite: a timeout is 'unknown' and is never resent blind", async () => {
  const twilio = fakeTwilio({ sendError: new Error("The signal has been aborted") });
  const store = fakeStore({ jobs: [job("j1")] });
  const fn = make(store, twilio);
  await call(fn, req({ mode: "dispatch" }, cron));
  assert.equal(store.s.jobs.get("j1").status, "unknown");
  // Next tick: Twilio's listing is read first; while it cannot be read the job stays unknown, unsent.
  const blind = make(store, fakeTwilio({ listError: new ProviderError(500, "20500", "x") }));
  await call(blind, req({ mode: "dispatch" }, cron));
  assert.equal(store.s.jobs.get("j1").status, "unknown");
  assert.equal(twilio.t.sends.length, 1);
});

test("crm-lite: reconciliation adopts a message Twilio did create (no second text)", async () => {
  const since = new Date(Date.now() - 120_000).toISOString();
  const store = fakeStore({ jobs: [job("j1", { status: "unknown", attempts: 1, since })] });
  const twilio = fakeTwilio({ listing: { complete: true, messages: [
    { sid: sid(77), body: BODY, status: "delivered", dateCreated: new Date().toISOString() },
  ] } });
  await call(make(store, twilio), req({ mode: "dispatch" }, cron));
  assert.equal(store.s.jobs.get("j1").status, "sent");
  assert.equal(store.s.jobs.get("j1").sid, sid(77));
  assert.equal(twilio.t.sends.length, 0);
});

test("crm-lite: reconciliation that proves nothing was created queues it again; an incomplete listing does not", async () => {
  const since = new Date(Date.now() - 120_000).toISOString();
  const absent = fakeStore({ jobs: [job("j1", { status: "unknown", attempts: 1, since })] });
  await call(make(absent, fakeTwilio({ listing: { complete: true, messages: [] } })), req({ mode: "dispatch" }, cron));
  assert.equal(absent.s.results[0].outcome, "absent");
  const partial = fakeStore({ jobs: [job("j1", { status: "unknown", attempts: 1, since })] });
  const newer = Array.from({ length: 50 }, (_, i) => ({ sid: sid(i), body: "other", status: "sent", dateCreated: new Date().toISOString() }));
  await call(make(partial, fakeTwilio({ listing: { complete: false, messages: newer } })), req({ mode: "dispatch" }, cron));
  assert.equal(partial.s.jobs.get("j1").status, "unknown");
  assert.equal(partial.s.results.length, 0);
});

test("crm-lite: Twilio's answers classify as rejected / transient / unknown", () => {
  assert.equal(classifySendError(new ProviderError(400, "21211", "Invalid To")).outcome, "rejected");
  assert.equal(classifySendError(new ProviderError(429, "20429", "Too many")).outcome, "transient");
  assert.equal(classifySendError(new ProviderError(503, null, "Unavailable")).outcome, "unknown");
  assert.equal(classifySendError(new TypeError("fetch failed")).outcome, "unknown");
});

test("crm-lite: a 4xx refusal fails the job; a 429 queues it again", async () => {
  const rejected = fakeStore({ jobs: [job("j1")] });
  await call(make(rejected, fakeTwilio({ sendError: new ProviderError(400, "21610", "unsubscribed") })), req({ mode: "dispatch" }, cron));
  assert.equal(rejected.s.jobs.get("j1").status, "failed");
  const limited = fakeStore({ jobs: [job("j1")] });
  await call(make(limited, fakeTwilio({ sendError: new ProviderError(429, "20429", "slow down") })), req({ mode: "dispatch" }, cron));
  assert.equal(limited.s.jobs.get("j1").status, "queued");
});

test("crm-lite: no API key in Vault means nothing is sent and the job waits", async () => {
  const twilio = fakeTwilio();
  const store = fakeStore({ jobs: [job("j1")], secrets: { [`TWILIO_SUB_${SENDER}_API_KEY`]: null } });
  await call(make(store, twilio), req({ mode: "dispatch" }, cron));
  assert.equal(twilio.t.sends.length, 0);
  assert.equal(store.s.results[0].error_code, "credentials_missing");
  assert.equal(store.s.jobs.get("j1").status, "queued");
});

test("crm-lite: only an admin issues an intake token; it is stored in Vault and answered once", async () => {
  const store = fakeStore();
  const fn = createCrmLite({ store, provider: fakeTwilio(), webhookBase: async () => BASE, token: () => "cit_fixed-for-test" });
  assert.equal((await call(fn, req({ mode: "issue_intake_token", source_id: SOURCE }, as("jwt-member")))).status, 403);
  assert.equal((await call(fn, req({ mode: "issue_intake_token", source_id: SOURCE }, cron))).status, 403);
  const r = await call(fn, req({ mode: "issue_intake_token", source_id: SOURCE }, as("jwt-admin")));
  assert.equal(r.status, 200);
  assert.equal(r.body.token, "cit_fixed-for-test");
  assert.deepEqual(store.s.vaultWrites, [{ name: "CRM_INTAKE_EXAMPLE_WEBSITE", value: "cit_fixed-for-test" }]);
  assert.deepEqual(store.s.issued, [{ id: SOURCE, actor: ADMIN }]);
});

test("crm-lite: a delivery test is an admin's, and a closed gate is refused before Twilio", async () => {
  const twilio = fakeTwilio();
  const blocked = make(fakeStore({ testBlocked: true }), twilio);
  const body = { mode: "send_test", recipient_id: "00000000-0000-4000-8000-0000000000e1", request_id: "00000000-0000-4000-8000-0000000000e2" };
  assert.equal((await call(blocked, req(body, as("jwt-member")))).status, 403);
  const r = await call(blocked, req(body, as("jwt-admin")));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "blocked");
  assert.equal(twilio.t.sends.length, 0);
  const open = fakeStore();
  const ok = await call(make(open, twilio), req(body, as("jwt-admin")));
  assert.equal(ok.status, 200);
  assert.equal(twilio.t.sends.length, 1);
});

test("crm-lite helpers: matching is exact text since the attempt; coverage needs an older message or a complete list", () => {
  const since = "2026-10-11T12:00:00Z";
  assert.equal(findSent([{ sid: "a", body: BODY, status: "sent", dateCreated: "2026-10-11T11:59:00Z" }], BODY, since), null);
  assert.equal(findSent([{ sid: "a", body: BODY + " ", status: "sent", dateCreated: "2026-10-11T12:01:00Z" }], BODY, since), null);
  assert.equal(findSent([{ sid: "a", body: BODY, status: "sent", dateCreated: "2026-10-11T12:01:00Z" }], BODY, since).sid, "a");
  assert.equal(listingCovers([{ dateCreated: "2026-10-11T12:05:00Z" }], false, since), false);
  assert.equal(listingCovers([{ dateCreated: "2026-10-11T11:00:00Z" }], false, since), true);
  assert.equal(listingCovers([], true, since), true);
});
