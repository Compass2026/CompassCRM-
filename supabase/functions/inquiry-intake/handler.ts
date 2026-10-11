// inquiry-intake (CRM Lite): a client's website server hands Compass one
// inquiry, server to server. Deployed with verify_jwt = false — the caller is
// a website, not a Supabase user — and authenticated here:
//
//   POST …/functions/v1/inquiry-intake
//   X-Compass-Source: <inquiry_sources.source_key>
//   Authorization: Bearer <the source's token, Vault inquiry_sources.secret_name>
//   { submission_id, name, email, phone, location, service_type, budget,
//     message, page_url, submitted_at, email_status, email_provider_id }
//
// The client is the source's client (inquiry_sources.client_id). Nothing in
// the body chooses it: a client_id there is ignored. An unknown source, a
// wrong token and a source whose token is not in Vault all answer the same
// 401, after the same work.
//
// Idempotent: crm_ingest_inquiry records a submission id once per source (a
// unique key), so a retried request answers the first inquiry's id with
// duplicate: true. Success (200) means the inquiry is committed in Postgres;
// anything else means it is not, and the caller keeps it and retries.
//
// Logs carry the source key, outcome codes and ids only — never a visitor's
// name, email, phone or message, and never the token.

export const HANDLER_VERSION = 1;
export const MAX_BODY_BYTES = 32_000;

export type Source = { id: string; client_id: string; enabled: boolean; secret_name: string; client_enabled: boolean };

export type Store = {
  source(key: string): Promise<Source | null>;
  secret(name: string): Promise<string | null>;
  ingest(p: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export type Log = (event: string, detail: Record<string, unknown>) => void;

type Json = Record<string, unknown>;
const reply = (status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const SOURCE_KEY = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SUBMISSION_ID = /^[A-Za-z0-9._:-]{8,100}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const LIMITS: Record<string, number> = {
  name: 200, email: 254, phone: 60, location: 200, service_type: 200, budget: 200, message: 10_000, page_url: 2_000,
  email_provider_id: 200,
};

// "code: message" from the database.
const codeOf = (e: unknown) => ((e instanceof Error ? e.message : String(e)).match(/^([a-z_]+):/) ?? [])[1] ?? "error";

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  return Array.from(await sha256(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares digests, so the time taken does not depend on where two tokens
// first differ or on their lengths.
export async function tokensMatch(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && expected.length > 0;
}

// The fields Compass stores, validated and trimmed; or the first problem.
export function cleanInquiry(body: unknown): { ok: true; value: Json } | { ok: false; problem: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, problem: "body" };
  const b = body as Json;
  const out: Json = {};
  const sub = typeof b.submission_id === "string" ? b.submission_id.trim() : "";
  if (!SUBMISSION_ID.test(sub)) return { ok: false, problem: "submission_id" };
  out.submission_id = sub;
  for (const [key, max] of Object.entries(LIMITS)) {
    const v = b[key];
    if (v == null || v === "") { out[key] = null; continue; }
    if (typeof v !== "string" || v.length > max) return { ok: false, problem: key };
    out[key] = key === "message" ? v : v.trim() || null;
  }
  if (!out.name) return { ok: false, problem: "name" };
  if (typeof out.message !== "string" || !out.message.trim()) return { ok: false, problem: "message" };
  if (out.email && !EMAIL.test(String(out.email))) return { ok: false, problem: "email" };
  if (!out.email && !out.phone) return { ok: false, problem: "email_or_phone" };
  if (out.page_url && !/^https:\/\//.test(String(out.page_url))) out.page_url = null;
  const status = b.email_status ?? "not_reported";
  if (!["not_reported", "failed", "accepted"].includes(String(status))) return { ok: false, problem: "email_status" };
  out.email_status = status;
  if (b.submitted_at != null) {
    const t = typeof b.submitted_at === "string" || typeof b.submitted_at === "number" ? new Date(b.submitted_at) : null;
    if (!t || Number.isNaN(t.getTime())) return { ok: false, problem: "submitted_at" };
    out.submitted_at = t.toISOString();
  } else out.submitted_at = null;
  return { ok: true, value: out };
}

// What the visitor submitted, hashed the same way on every retry (the
// website's email outcome and the request time are not part of it).
export async function payloadHash(v: Json): Promise<string> {
  const keys = ["submission_id", "name", "email", "phone", "location", "service_type", "budget", "message", "page_url"];
  return sha256Hex(JSON.stringify(keys.map((k) => v[k] ?? null)));
}

export function createInquiryIntake(deps: { store: Store; kick?: () => Promise<void>; waitUntil?: (p: Promise<unknown>) => void; log?: Log }) {
  const { store } = deps;
  const log: Log = deps.log ?? (() => {});

  async function handle(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (e) {
      log("error", { code: codeOf(e) });
      return reply(503, { ok: false, error: "unavailable" });
    }
  }

  async function route(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return reply(415, { ok: false, error: "JSON only" });
    }
    const key = (req.headers.get("x-compass-source") ?? "").trim();
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    // Same answer and the same work for every way of being wrong.
    const source = SOURCE_KEY.test(key) ? await store.source(key) : null;
    const expected = source ? await store.secret(source.secret_name) : null;
    const ok = await tokensMatch(token, expected ?? "never-matches-" + crypto.randomUUID());
    if (!source || !expected || !token || !ok) {
      log("rejected", { source: SOURCE_KEY.test(key) ? key : null, reason: !source ? "unknown_source" : !expected ? "no_token_in_vault" : "bad_token" });
      return reply(401, { ok: false, error: "unauthorized" });
    }

    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return reply(413, { ok: false, error: "too_large" });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: "invalid", field: "body" }); }
    const clean = cleanInquiry(body);
    if (!clean.ok) {
      log("invalid", { source: key, field: clean.problem });
      return reply(400, { ok: false, error: "invalid", field: clean.problem });
    }

    let result: Json;
    try {
      result = await store.ingest({ ...clean.value, source_id: source.id, payload_sha256: await payloadHash(clean.value) });
    } catch (e) {
      const code = codeOf(e);
      log("ingest_failed", { source: key, submission: clean.value.submission_id, code });
      if (code === "not_enabled") return reply(403, { ok: false, error: "not_enabled" });
      if (code === "invalid") return reply(400, { ok: false, error: "invalid" });
      return reply(503, { ok: false, error: "unavailable" });
    }

    const jobs = Array.isArray(result.jobs) ? (result.jobs as Json[]) : [];
    const queued = jobs.filter((j) => j.status === "queued").length;
    log("saved", { source: key, submission: clean.value.submission_id, inquiry: result.inquiry_id, duplicate: result.duplicate === true,
      alerts_queued: queued, alerts_blocked: jobs.length - queued });
    if (queued > 0 && deps.kick) {
      const p = deps.kick().catch(() => log("kick_failed", { inquiry: result.inquiry_id }));
      if (deps.waitUntil) deps.waitUntil(p); else await p;
    }
    return reply(200, { ok: true, inquiry_id: result.inquiry_id, duplicate: result.duplicate === true });
  }

  return { handle, version: HANDLER_VERSION };
}
