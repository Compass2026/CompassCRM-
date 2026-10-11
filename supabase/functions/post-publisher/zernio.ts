// The post publisher's Zernio client (Zernio Social Publisher v1;
// docs/zernio-publisher.md). Transport only: Compass decides what is posted,
// where and when; this sends the exact request the handler built.
//
// Every request is one of an allowlist of method + path pairs; anything else
// is refused before fetch is called. Reads: the Facebook and Business Profile
// accounts the key sees, an account's selected Page or its Business Profile
// locations, its health, one post. Writes: a media
// upload link (POST /v1/media/presign), the upload itself (a PUT of the bytes
// to the presigned https URL, which never carries the key), and creating a
// post (POST /v1/posts, always with an Idempotency-Key). There is no delete,
// edit, unpublish, retry, account-connection or webhook call here.
//
// The key is ZERNIO_PUBLISH_API_KEY in Vault, sent only in the Authorization
// header to https://zernio.com/api. It is never logged, returned or part of
// an error; SH1's read key (ZERNIO_READ_API_KEY) is never used for this.
//
// Nothing throws: every call answers an Answer (status 0 = no answer or
// refused locally), so the handler decides from one shape.

import type { Answer } from "./facebook.ts";

export const ZERNIO_BASE = "https://zernio.com/api";
export const ZERNIO_READ_TIMEOUT_MS = 20_000;
export const ZERNIO_CREATE_TIMEOUT_MS = 60_000;
export const ZERNIO_UPLOAD_TIMEOUT_MS = 60_000;

const ID = "[0-9a-f]{24}";
const POST_ID = "[0-9A-Za-z_-]{1,64}";
// method + path → the query parameters it may carry.
export const ZERNIO_PUBLISH_ALLOWLIST: readonly { method: "GET" | "POST"; path: RegExp; query: readonly string[] }[] = [
  { method: "GET", path: /^\/v1\/accounts$/, query: ["platform", "page", "limit"] },
  { method: "GET", path: new RegExp(`^/v1/accounts/${ID}/facebook-page$`), query: [] },
  { method: "GET", path: new RegExp(`^/v1/accounts/${ID}/gmb-locations$`), query: ["limit"] },
  { method: "GET", path: new RegExp(`^/v1/accounts/${ID}/health$`), query: [] },
  { method: "GET", path: new RegExp(`^/v1/posts/${POST_ID}$`), query: [] },
  { method: "POST", path: /^\/v1\/media\/presign$/, query: [] },
  { method: "POST", path: /^\/v1\/posts$/, query: [] },
];

// Keys never appear in a message, whatever Zernio echoes back.
export const scrub = (s: string) => s.replace(/\b(?:sk|zrk|zk|lk)_[A-Za-z0-9_-]+/g, "[key]").replace(/Bearer\s+\S+/gi, "Bearer [key]").slice(0, 300);

const local = (code: string, message: string): Answer => ({ ok: false, status: 0, json: null, code, message, retryAfterS: null });

export function allowedUrl(method: string, path: string, query: Record<string, string | number | undefined> = {}): URL | Answer {
  const rule = ZERNIO_PUBLISH_ALLOWLIST.find((r) => r.method === method && r.path.test(path));
  if (!rule) return local("not_allowed", `Zernio ${method} ${path} is not on the publisher's allowlist`);
  const url = new URL(ZERNIO_BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (!rule.query.includes(k)) return local("not_allowed", `Query "${k}" is not allowed on ${path}`);
    url.searchParams.set(k, String(v));
  }
  return url;
}

export type ZernioAccount = {
  _id: string; platform?: string; username?: string; displayName?: string; platformUserId?: string;
  isActive?: boolean; enabled?: boolean; needsReconnection?: boolean; profileId?: string | { _id?: string; name?: string } | null;
};
export type ZernioGbpLocations = { locations?: import("./gbp.ts").ZernioLocation[]; selectedLocationId?: string | null; hasMore?: boolean; cached?: boolean };
export type ZernioFacebookPage = { pages?: { id: string; name?: string; username?: string }[]; selectedPageId?: string | null };
export type Presign = { uploadUrl: string; publicUrl: string; expiresIn?: number };

export function createZernioPublisher(deps: { apiKey: string; fetch: typeof fetch; readTimeoutMs?: number; createTimeoutMs?: number }) {
  const key = deps.apiKey;
  const ready = !!key && !/\s/.test(key);

  async function call(method: "GET" | "POST", path: string, o: { query?: Record<string, string | number | undefined>; body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {}): Promise<Answer> {
    if (!ready) return local("key_invalid", "The Zernio publish key is missing or malformed.");
    const url = allowedUrl(method, path, o.query);
    if (!(url instanceof URL)) return url;
    if (path === "/v1/posts" && method === "POST" && !o.idempotencyKey) return local("no_idempotency_key", "A post is never created without an Idempotency-Key.");
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;
    let res: Response;
    try {
      res = await deps.fetch(url.toString(), {
        method, headers, redirect: "error",
        body: method === "POST" ? JSON.stringify(o.body ?? {}) : undefined,
        signal: AbortSignal.timeout(o.timeoutMs ?? deps.readTimeoutMs ?? ZERNIO_READ_TIMEOUT_MS),
      });
    } catch (e) {
      return local("no_answer", `Zernio did not answer: ${scrub(e instanceof Error ? e.message : String(e))}`);
    }
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    const retry = Number(res.headers.get("retry-after"));
    const err = (json?.error ?? null) as unknown;
    const code = typeof json?.code === "string" ? json.code
      : typeof err === "object" && err && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code
      : typeof err === "string" && /^[A-Za-z_]+$/.test(err) ? err : null;
    const text = typeof json?.message === "string" ? json.message
      : typeof err === "string" ? err
      : typeof err === "object" && err && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message
      : res.statusText || "";
    return {
      ok: res.ok, status: res.status, json, code,
      message: res.ok ? "" : `Zernio ${res.status}: ${scrub(String(text || "error"))}`,
      retryAfterS: Number.isFinite(retry) && retry >= 0 ? retry : null,
    };
  }

  // Every account of one platform the key can see (paged).
  async function accountsOf(platform: "facebook" | "googlebusiness"): Promise<{ answer: Answer; accounts: ZernioAccount[] }> {
    const accounts: ZernioAccount[] = [];
    let answer: Answer = local("not_run", "");
    for (let page = 1; page <= 10; page++) {
      answer = await call("GET", "/v1/accounts", { query: { platform, page, limit: 100 } });
      if (!answer.ok) return { answer, accounts: [] };
      const j = answer.json as { accounts?: ZernioAccount[]; pagination?: { pages?: number } } | null;
      accounts.push(...(j?.accounts ?? []));
      if (!j?.pagination?.pages || page >= j.pagination.pages) break;
    }
    return { answer, accounts: accounts.filter((a) => a.platform === platform) };
  }

  return {
    facebookAccounts: () => accountsOf("facebook"),
    gbpAccounts: () => accountsOf("googlebusiness"),
    facebookPage: (accountId: string) => call("GET", `/v1/accounts/${accountId}/facebook-page`),
    // The Business Profile locations the account manages, and its selected one.
    gbpLocations: (accountId: string) => call("GET", `/v1/accounts/${accountId}/gmb-locations`, { query: { limit: 500 } }),
    health: (accountId: string) => call("GET", `/v1/accounts/${accountId}/health`),
    getPost: (postId: string) => call("GET", `/v1/posts/${postId}`),
    presign: (o: { filename: string; contentType: string; size: number }) => call("POST", "/v1/media/presign", { body: o }),
    createPost: (body: unknown, idempotencyKey: string) =>
      call("POST", "/v1/posts", { body, idempotencyKey, timeoutMs: deps.createTimeoutMs ?? ZERNIO_CREATE_TIMEOUT_MS }),

    // The bytes, to the presigned URL Zernio just gave. https only, no key,
    // no redirects.
    async upload(uploadUrl: string, bytes: Uint8Array, contentType: string): Promise<Answer> {
      let u: URL;
      try { u = new URL(uploadUrl); } catch { return local("bad_upload_url", "Zernio's upload link is not a URL."); }
      if (u.protocol !== "https:") return local("bad_upload_url", "Zernio's upload link is not https.");
      try {
        const res = await deps.fetch(u.toString(), {
          method: "PUT", headers: { "Content-Type": contentType }, body: new Blob([new Uint8Array(bytes)], { type: contentType }), redirect: "error",
          signal: AbortSignal.timeout(ZERNIO_UPLOAD_TIMEOUT_MS),
        });
        return { ok: res.ok, status: res.status, json: null, code: null, message: res.ok ? "" : `Upload refused (${res.status}).`, retryAfterS: null };
      } catch (e) {
        return local("no_answer", `The upload did not finish: ${scrub(e instanceof Error ? e.message : String(e))}`);
      }
    },
  };
}

export type ZernioPublisher = ReturnType<typeof createZernioPublisher>;
