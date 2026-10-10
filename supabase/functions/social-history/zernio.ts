// Social History's read-only Zernio client (SH1). The only code in Compass
// that talks to Zernio.
//
// It can only read. There is no method, option or code path that sends
// anything but GET: every request is built here as a GET with no body, its
// path must match ZERNIO_GET_ALLOWLIST and its query names the allowlist for
// that path, and anything else throws before fetch is called
// (tests/social-history-zernio.test.mjs proves it, and scans the function's
// sources for any other method or fetch). Publishing, scheduling, editing,
// deleting, Zernio's on-demand external sync (a POST), account / Page
// connection, inbox comments and messages, webhooks, keys, ads and media
// upload are not reachable from here.
//
// The key is ZERNIO_READ_API_KEY in Vault: a Zernio key created with
// permission "read" (GET only), scoped to the client's Zernio profile. It is
// sent only in the Authorization header to https://zernio.com/api, never
// logged, never returned and never part of an error message.

export const ZERNIO_BASE = "https://zernio.com/api";
export const ZERNIO_KEY_SECRET = "ZERNIO_READ_API_KEY";
export const ZERNIO_TIMEOUT_MS = 20_000;
export const ZERNIO_MAX_RETRY_AFTER_S = 20;

const ACCOUNT_ID = "[0-9a-f]{24}";
// path pattern → the query parameters it may carry. Nothing else is requested.
export const ZERNIO_GET_ALLOWLIST: readonly { path: RegExp; query: readonly string[] }[] = [
  { path: /^\/v1\/profiles$/, query: ["limit", "skip"] },
  { path: /^\/v1\/accounts$/, query: ["platform", "profileId", "page", "limit"] },
  { path: new RegExp(`^/v1/accounts/${ACCOUNT_ID}/facebook-page$`), query: [] },
  { path: /^\/v1\/analytics$/, query: ["accountId", "platform", "source", "fromDate", "toDate", "limit", "page", "sortBy", "order"] },
];

export class ZernioError extends Error {
  readonly status: number;                   // HTTP status; 0 = no answer (network / timeout) or refused locally
  readonly code: string | null;
  readonly retryAfterS: number | null;
  constructor(status: number, code: string | null, message: string, retryAfterS: number | null = null) {
    super(message);
    this.name = "ZernioError";
    this.status = status;
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
  // Worth trying again later: rate limited, Zernio's 5xx, no answer.
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

// ── Response shapes (OpenAPI v1.240.0; only the fields Compass reads) ─────────
export type ZernioProfile = { _id: string; name?: string; accountCount?: number; isDefault?: boolean };
export type ZernioAccount = {
  _id: string;
  platform: string;
  profileId?: string | { _id: string; name?: string } | null;
  username?: string;
  displayName?: string;
  platformUserId?: string;
  profileUrl?: string;
  isActive?: boolean;
  needsReconnection?: boolean;
  enabled?: boolean;
};
export type ZernioFacebookPage = {
  pages?: { id: string; name?: string; username?: string; category?: string; fan_count?: number }[];
  selectedPageId?: string | null;
  cached?: boolean;
};
export type ZernioMetrics = {
  impressions?: number; reach?: number; likes?: number; comments?: number; shares?: number; saves?: number;
  clicks?: number; views?: number; engagementRate?: number; lastUpdated?: string;
} & Record<string, unknown>;
export type ZernioPlatformEntry = {
  platform?: string;
  status?: string;
  platformPostId?: string | null;
  accountId?: string;
  accountUsername?: string | null;
  analytics?: ZernioMetrics | null;
  syncStatus?: "synced" | "pending" | "unavailable" | string;
  platformPostUrl?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  isOwner?: boolean | null;
};
export type ZernioMediaItem = {
  type?: string; url?: string | null; thumbnail?: string | null; altText?: string;
  mediaStatus?: string; unavailableReason?: string;
};
export type ZernioAnalyticsPost = {
  _id?: string;
  postId?: string;
  latePostId?: string | null;
  content?: string | null;
  scheduledFor?: string;
  publishedAt?: string | null;
  status?: string;
  analytics?: ZernioMetrics | null;
  platforms?: ZernioPlatformEntry[];
  platformAnalytics?: ZernioPlatformEntry[];
  platform?: string;
  platformPostUrl?: string | null;
  isExternal?: boolean;
  isAd?: boolean;
  profileId?: string | null;
  thumbnailUrl?: string | null;
  mediaType?: string | null;
  mediaItems?: ZernioMediaItem[];
  syncStatus?: string;
} & Record<string, unknown>;
export type ZernioAnalyticsList = {
  overview?: Record<string, unknown>;
  posts?: ZernioAnalyticsPost[];
  pagination?: { page?: number; limit?: number; total?: number; pages?: number };
  accounts?: ZernioAccount[];
  hasAnalyticsAccess?: boolean;
};

export type ReaderDeps = {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

// Keys never appear in an error, whatever Zernio echoes back.
const scrub = (s: string) => s.replace(/\b(?:sk|zrk)_[A-Za-z0-9_-]+/g, "[key]").slice(0, 300);

export function allowedRequest(path: string, query: Record<string, string | number | undefined>): URL {
  const rule = ZERNIO_GET_ALLOWLIST.find((r) => r.path.test(path));
  if (!rule) throw new ZernioError(0, "path_not_allowed", `Zernio path not on the read-only allowlist: ${path}`);
  const url = new URL(ZERNIO_BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (!rule.query.includes(k)) throw new ZernioError(0, "query_not_allowed", `Query "${k}" is not allowed on ${path}`);
    url.searchParams.set(k, String(v));
  }
  return url;
}

export function createZernioReader(deps: ReaderDeps) {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? ZERNIO_TIMEOUT_MS;
  if (!deps.apiKey || /\s/.test(deps.apiKey)) throw new ZernioError(0, "key_invalid", "The Zernio key is empty or malformed");

  // The one place a request is made. GET, no body, no redirects.
  async function get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = allowedRequest(path, query);
    for (let attempt = 1; ; attempt++) {
      const req = new Request(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiKey}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (req.method !== "GET" || req.body !== null) throw new ZernioError(0, "method_not_allowed", "Only GET is ever sent");
      let res: Response;
      try {
        res = await doFetch(req);
      } catch (e) {
        throw new ZernioError(0, "no_answer", `Zernio did not answer: ${scrub(e instanceof Error ? e.message : String(e))}`);
      }
      if (res.ok) {
        try { return (await res.json()) as T; }
        catch { throw new ZernioError(res.status, "bad_json", "Zernio answered with something other than JSON"); }
      }
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string; code?: string } | null;
      const retryAfter = Number(res.headers.get("retry-after"));
      const retryAfterS = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
      if (res.status === 429 && attempt === 1 && retryAfterS !== null && retryAfterS <= ZERNIO_MAX_RETRY_AFTER_S) {
        await sleep(retryAfterS * 1000);
        continue;
      }
      const code = body?.code ?? (typeof body?.error === "string" && /^[a-z_]+$/.test(body.error) ? body.error : null);
      const text = scrub(String(body?.message ?? body?.error ?? res.statusText ?? "error"));
      throw new ZernioError(res.status, code, `Zernio ${res.status}: ${text}`, retryAfterS);
    }
  }

  return {
    async profiles(): Promise<ZernioProfile[]> {
      const r = await get<{ profiles?: ZernioProfile[] }>("/v1/profiles", { limit: 100 });
      return r.profiles ?? [];
    },
    // Every Facebook account the key can see (paged, 100 at a time).
    async facebookAccounts(): Promise<{ accounts: ZernioAccount[]; hasAnalyticsAccess: boolean | null }> {
      const out: ZernioAccount[] = [];
      let access: boolean | null = null;
      for (let page = 1; page <= 10; page++) {
        const r = await get<{ accounts?: ZernioAccount[]; hasAnalyticsAccess?: boolean; pagination?: { pages?: number } }>(
          "/v1/accounts", { platform: "facebook", page, limit: 100 });
        out.push(...(r.accounts ?? []));
        if (typeof r.hasAnalyticsAccess === "boolean") access = r.hasAnalyticsAccess;
        if (!r.pagination?.pages || page >= r.pagination.pages) break;
      }
      return { accounts: out.filter((a) => a.platform === "facebook"), hasAnalyticsAccess: access };
    },
    async facebookPage(accountId: string): Promise<ZernioFacebookPage> {
      return await get<ZernioFacebookPage>(`/v1/accounts/${accountId}/facebook-page`);
    },
    // Posts with their analytics, newest first (Zernio's maximum range is 366 days).
    async analyticsPage(o: { accountId: string; fromDate: string; page: number; limit: number }): Promise<ZernioAnalyticsList> {
      return await get<ZernioAnalyticsList>("/v1/analytics", {
        accountId: o.accountId, platform: "facebook", source: "all", fromDate: o.fromDate,
        limit: o.limit, page: o.page, sortBy: "date", order: "desc",
      });
    },
  };
}

export type ZernioReader = ReturnType<typeof createZernioReader>;
