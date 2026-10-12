// crm-lite (CRM Lite): the inquiry-alert dispatcher and the admin actions
// that need Vault. verify_jwt = true; callers are the pg_cron tick and
// inquiry-intake (x-cron-secret) or a signed-in teammate (JWT).
//
//   {mode: "version"}
//   {mode: "dispatch"}                       cron / inquiry-intake / any teammate
//   {mode: "issue_intake_token", source_id}  an admin; the token is answered
//                                            once and stored only in Vault
//   {mode: "send_test", recipient_id, request_id}
//                                            an admin; one delivery test
//
// Dispatch, in order:
//   1. Jobs whose outcome is unknown (a send whose answer never came back)
//      are checked against Twilio first: found → sent (its SID adopted);
//      Twilio's list complete and nothing there → safe to queue again; a
//      failed or incomplete check leaves the job unknown. Never a blind resend.
//   2. Queued jobs are claimed by the database, which re-checks every gate
//      (sender approved and enabled, the client's switch, complete consent,
//      no STOP, a confirmed delivery test, < 24 h old) and marks each claimed
//      job 'sending' BEFORE Twilio is called.
//   3. Twilio's answer: created → sent; a 4xx refusal → failed; 429 → queued
//      again with backoff; a 5xx, timeout or network error → unknown (step 1).
//
// Messages carry Compass's alert text only (built in the database); the
// inquiry's details never reach this function. Logs carry ids and codes.
import type { MessagingProvider, SubaccountCredential } from "../_shared/communications/provider.ts";
import { ProviderError } from "../_shared/communications/provider.ts";
import { subaccountCredential, type SubaccountSecrets } from "../_shared/communications/credentials.ts";

export const HANDLER_VERSION = 1;
export const SEND_BATCH = 5;
export const RECONCILE_PAGE = 50;

type Json = Record<string, unknown>;

export type Caller = "none" | { member: string | null; role: string | null };

export type Store = {
  secret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
  subaccountSecrets(accountSid: string): Promise<SubaccountSecrets>;
  caller(jwt: string): Promise<Caller>;
  source(id: string): Promise<{ id: string; secret_name: string } | null>;
  recordTokenIssued(sourceId: string, actorId: string): Promise<Json>;
  claim(limit: number): Promise<Json[]>;
  claimUnknown(limit: number): Promise<Json[]>;
  result(p: Json): Promise<Json>;
  beginTest(p: Json): Promise<Json>;
  job(id: string): Promise<Json | null>;
};

export type Log = (event: string, detail: Json) => void;

const reply = (status: number, body: Json) => Response.json(body, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (e: unknown) => ((e instanceof Error ? e.message : String(e)).match(/^([a-z_]+):/) ?? [])[1] ?? "error";

// What a send attempt's answer means for the job.
export function classifySendError(e: unknown): { outcome: "rejected" | "transient" | "unknown"; code: string | null; message: string } {
  if (e instanceof ProviderError) {
    if (e.status === 429) return { outcome: "transient", code: e.code ?? "429", message: "Twilio is rate limiting; retrying later" };
    if (e.status >= 400 && e.status < 500) return { outcome: "rejected", code: e.code, message: e.message };
    // A 5xx may come after Twilio created the message: check before resending.
    return { outcome: "unknown", code: e.code ?? String(e.status), message: `Twilio answered ${e.status}; checking before any resend` };
  }
  return { outcome: "unknown", code: null, message: "No answer from Twilio; checking before any resend" };
}

// Reconciliation: the one message Compass would have created, if Twilio has
// it. Exact text, same numbers, created at or after the attempt began.
export function findSent(messages: { sid: string; body: string; status: string; dateCreated: string | null }[], body: string, since: string) {
  const after = Date.parse(since);
  const matches = messages.filter((m) => m.body === body && (m.dateCreated == null || Date.parse(m.dateCreated) >= after));
  return matches[0] ?? null;
}

// Whether the page read reaches back past the attempt (so "not there" means
// not created): Twilio lists newest first.
export function listingCovers(messages: { dateCreated: string | null }[], complete: boolean, since: string): boolean {
  if (complete) return true;
  const after = Date.parse(since);
  return messages.some((m) => m.dateCreated != null && Date.parse(m.dateCreated) < after);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "cit_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createCrmLite(deps: {
  store: Store;
  provider: Pick<MessagingProvider, "sendMessage" | "listMessages">;
  webhookBase: () => Promise<string>;
  log?: Log;
  token?: () => string;
}) {
  const { store, provider } = deps;
  const log: Log = deps.log ?? (() => {});
  const token = deps.token ?? randomToken;

  async function caller(req: Request): Promise<{ via: "cron" } | { via: "team"; member: string; admin: boolean } | 401 | 403> {
    const cron = await store.secret("SYNC_CRON_SECRET");
    const header = req.headers.get("x-cron-secret");
    if (cron && header && header === cron) return { via: "cron" };
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const who = await store.caller(jwt);
    if (who !== "none" && who.member) return { via: "team", member: who.member, admin: who.role === "admin" };
    return who === "none" && !header ? 401 : 403;
  }

  const credentials = new Map<string, SubaccountCredential | null>();
  async function credentialFor(accountSid: string): Promise<SubaccountCredential | null> {
    if (!credentials.has(accountSid)) credentials.set(accountSid, subaccountCredential(await store.subaccountSecrets(accountSid)));
    return credentials.get(accountSid) ?? null;
  }

  async function reconcile(): Promise<Json> {
    const out = { checked: 0, found: 0, absent: 0, still_unknown: 0 };
    for (const j of await store.claimUnknown(SEND_BATCH)) {
      out.checked++;
      const id = String(j.job_id);
      try {
        const cred = await credentialFor(String(j.account_sid));
        if (!cred) { out.still_unknown++; log("reconcile_skipped", { job: id, reason: "credentials_missing" }); continue; }
        const listed = await provider.listMessages(cred, { to: String(j.to), from: String(j.from), pageSize: RECONCILE_PAGE });
        const hit = findSent(listed.messages, String(j.body), String(j.since));
        if (hit) {
          await store.result({ job_id: id, outcome: "found", message_sid: hit.sid, provider_status: hit.status });
          out.found++;
          log("reconciled", { job: id, result: "found", message: hit.sid });
        } else if (listingCovers(listed.messages, listed.complete, String(j.since))) {
          await store.result({ job_id: id, outcome: "absent" });
          out.absent++;
          log("reconciled", { job: id, result: "absent" });
        } else {
          out.still_unknown++;
          log("reconciled", { job: id, result: "incomplete_listing" });
        }
      } catch (e) {
        out.still_unknown++;
        log("reconcile_failed", { job: id, code: e instanceof ProviderError ? e.code ?? e.status : codeOf(e) });
      }
    }
    return out;
  }

  async function send(): Promise<Json> {
    const out = { claimed: 0, sent: 0, failed: 0, retrying: 0, unknown: 0 };
    const base = await deps.webhookBase();
    for (const j of await store.claim(SEND_BATCH)) {
      out.claimed++;
      const id = String(j.job_id);
      const cred = await credentialFor(String(j.account_sid)).catch(() => null);
      if (!cred) {
        // Nothing reached Twilio: safe to retry once the key is in Vault.
        await store.result({ job_id: id, outcome: "transient", error_code: "credentials_missing",
          error_message: "The alert sender's API key is not in Vault (TWILIO_SUB_<sid>_API_KEY / _API_SECRET)" });
        out.retrying++;
        log("send_skipped", { job: id, reason: "credentials_missing" });
        continue;
      }
      try {
        const r = await provider.sendMessage(cred, {
          messagingServiceSid: (j.messaging_service_sid as string | null) ?? null,
          from: String(j.from),
          to: String(j.to),
          body: String(j.body),
          statusCallbackUrl: `${base}/notifications/status?j=${encodeURIComponent(id)}`,
        });
        await store.result({ job_id: id, outcome: "accepted", message_sid: r.sid, provider_status: r.status });
        out.sent++;
        log("sent", { job: id, message: r.sid, status: r.status });
      } catch (e) {
        const c = classifySendError(e);
        const r = await store.result({ job_id: id, outcome: c.outcome, error_code: c.code, error_message: c.message });
        if (c.outcome === "rejected") out.failed++;
        else if (c.outcome === "unknown") out.unknown++;
        else if (r.status === "failed") out.failed++;
        else out.retrying++;
        log("send_failed", { job: id, outcome: c.outcome, code: c.code });
      }
    }
    return out;
  }

  async function dispatch(): Promise<Json> {
    const reconciled = await reconcile();
    const sent = await send();
    return { reconciled, sent };
  }

  async function handle(req: Request): Promise<Response> {
    try {
      if (req.method !== "POST") return reply(405, { error: "POST only" });
      const body = (await req.json().catch(() => null)) as Json | null;
      if (!body || typeof body.mode !== "string") return reply(400, { error: "mode is required" });
      if (body.mode === "version") return reply(200, { version: HANDLER_VERSION, features: ["dispatch", "reconcile_unknown", "issue_intake_token", "send_test"] });

      const who = await caller(req);
      if (who === 401) return reply(401, { error: "sign in" });
      if (who === 403) return reply(403, { error: "Only Compass teammates" });

      if (body.mode === "dispatch") return reply(200, { ok: true, ...(await dispatch()) });

      if (who.via !== "team" || !who.admin) return reply(403, { error: "Only a Compass admin" });

      if (body.mode === "issue_intake_token") {
        const sourceId = String(body.source_id ?? "");
        if (!UUID.test(sourceId)) return reply(400, { error: "source_id" });
        const source = await store.source(sourceId);
        if (!source) return reply(404, { error: "no such source" });
        const value = token();
        await store.setSecret(source.secret_name, value);
        await store.recordTokenIssued(source.id, who.member);
        log("token_issued", { source: source.id, secret: source.secret_name });
        // Shown once to the admin, for the website's server environment.
        return reply(200, { ok: true, secret_name: source.secret_name, token: value });
      }

      if (body.mode === "send_test") {
        const recipientId = String(body.recipient_id ?? "");
        const requestId = String(body.request_id ?? "");
        if (!UUID.test(recipientId) || !UUID.test(requestId)) return reply(400, { error: "recipient_id and request_id" });
        let begun: Json;
        try {
          begun = await store.beginTest({ recipient_id: recipientId, request_id: requestId, actor_id: who.member });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return reply(409, { error: codeOf(e), detail: msg.slice(0, 300) });
        }
        const result = begun.duplicate ? null : await dispatch();
        const job = await store.job(String(begun.job_id));
        return reply(200, { ok: true, job_id: begun.job_id, duplicate: begun.duplicate === true, job: job ? {
          status: job.status, provider_status: job.provider_status, error_code: job.error_code, error_message: job.error_message,
        } : null, dispatch: result });
      }

      return reply(400, { error: "unknown mode" });
    } catch (e) {
      log("error", { code: codeOf(e) });
      return reply(424, { error: "unavailable", code: codeOf(e) });
    }
  }

  return { handle, dispatch, version: HANDLER_VERSION };
}
