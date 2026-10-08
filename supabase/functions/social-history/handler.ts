// social-history (Social History SH1): read a client's published Facebook
// posts and their metrics from Zernio, read-only, into Compass's canonical
// store. Style / performance evidence only; never grounding, never
// publishing (docs/social-history.md).
//
//   version → what this deployment is, the GET allowlist, whether the key
//             is present (yes / no only).
//   plan    → the dry run. Writes nothing. What the key can see, the Facebook
//             account and Page that would be imported, and a sample of up to
//             25 posts (default 20) as Zernio returned them next to the rows
//             Compass would store, with a field-quality report. It ends with
//             the exact import request to send.
//   import  → the latest `limit` posts (1–100) of the Page the plan named.
//             The request must repeat the plan's account_id and page_id; if
//             Zernio now says otherwise nothing is written. 202 {import_id},
//             then in the background: pages of the listing, mapped, recorded
//             in batches of 25, finished completed / partial / failed.
//
// Callers: a signed-in teammate (JWT on team_members); `import` needs an
// admin. No cron caller and no schedule in SH1. Deployed with verify_jwt.
// Every Zernio request is a GET (zernio.ts).
import { createZernioReader, ZernioError, ZERNIO_GET_ALLOWLIST, ZERNIO_KEY_SECRET, type ZernioAccount, type ZernioReader } from "./zernio.ts";
import { fieldReport, mapPost, type Mapped, type PostRow } from "./map.ts";
import type { Store } from "./store.ts";

export const HANDLER_VERSION = 1;
export const MODES = ["version", "plan", "import"] as const;
export const PLAN_SAMPLE = { default: 20, max: 25 } as const;
export const IMPORT_LIMIT = { default: 100, max: 100 } as const;
export const BATCH = 25;
export const WINDOW_DAYS = 365;          // Zernio's analytics range is at most 366 days

export type Deps = {
  store: Store;
  fetch?: typeof fetch;                                   // Zernio's transport (tests: a fake)
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  waitUntil?: (p: Promise<unknown>) => void;              // default: EdgeRuntime.waitUntil
};

type Json = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[0-9a-f]{24}$/;
const reply = (status: number, body: Json) => Response.json(body, { status });

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const profileIdOf = (a: ZernioAccount) => (typeof a.profileId === "string" ? a.profileId : a.profileId?._id ?? null);
const accountView = (a: ZernioAccount) => ({
  id: a._id, platform: a.platform, display_name: a.displayName ?? null, username: a.username ?? null,
  platform_user_id: a.platformUserId ?? null, profile_id: profileIdOf(a), profile_url: a.profileUrl ?? null,
  is_active: a.isActive ?? null, needs_reconnection: a.needsReconnection ?? null,
});
const safe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export function createSocialHistory(deps: Deps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const waitUntil = deps.waitUntil ?? ((p: Promise<unknown>) => {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
  });
  const fromDate = () => new Date(now().getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  async function reader(): Promise<ZernioReader | null> {
    const key = await store.secret(ZERNIO_KEY_SECRET);
    if (!key) return null;
    return createZernioReader({ apiKey: key, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  }

  function zernioReply(e: unknown): Response {
    if (e instanceof ZernioError) {
      const status = e.status === 401 || e.status === 403 ? 424 : e.status === 402 ? 424 : e.transient ? 503 : 502;
      return reply(status, {
        error: e.status === 401 || e.status === 403 ? "zernio_key_rejected" : e.status === 402 ? "zernio_analytics_not_included" : "zernio_error",
        zernio_status: e.status, zernio_code: e.code, message: e.message,
      });
    }
    throw e;
  }

  // The account and Page to import, decided only from what Zernio and the
  // CRM say. Never picks one of several.
  async function resolveAccount(z: ZernioReader, clientId: string, accountId: string | null) {
    const { accounts, hasAnalyticsAccess } = await z.facebookAccounts();
    const recorded = await store.socialAccount(clientId);
    let chosen: ZernioAccount | null = null;
    if (accountId) {
      chosen = accounts.find((a) => a._id === accountId) ?? null;
      if (!chosen) return { refusal: reply(404, { error: "account_not_visible", account_id: accountId, visible: accounts.map(accountView) }) };
    } else if (recorded?.external_account_id) {
      const hits = accounts.filter((a) => a.platformUserId === recorded.external_account_id);
      if (hits.length !== 1) {
        return { refusal: reply(409, { error: hits.length ? "account_ambiguous" : "recorded_page_not_visible",
          recorded_page_id: recorded.external_account_id, visible: accounts.map(accountView) }) };
      }
      chosen = hits[0];
    } else if (accounts.length === 1) {
      chosen = accounts[0];
    } else {
      return { refusal: reply(accounts.length ? 409 : 404, {
        error: accounts.length ? "account_ambiguous" : "no_facebook_account",
        message: accounts.length ? "The key sees several Facebook accounts; name one with account_id." : "The key sees no Facebook account.",
        visible: accounts.map(accountView) }) };
    }
    const page = await z.facebookPage(chosen._id);
    const pageId = page.selectedPageId ?? chosen.platformUserId ?? null;
    const pageMatch = !!pageId && (!chosen.platformUserId || !page.selectedPageId || chosen.platformUserId === page.selectedPageId);
    const pageName = page.pages?.find((p) => p.id === pageId)?.name ?? chosen.displayName ?? null;
    return { accounts, hasAnalyticsAccess, recorded, chosen, page, pageId, pageMatch, pageName };
  }

  async function plan(clientId: string, body: Json, client: { id: string; name: string }): Promise<Response> {
    const sample = body.sample === undefined ? PLAN_SAMPLE.default : body.sample;
    if (!Number.isInteger(sample) || (sample as number) < 1 || (sample as number) > PLAN_SAMPLE.max) {
      return reply(400, { error: `sample is a whole number from 1 to ${PLAN_SAMPLE.max}` });
    }
    const accountId = body.account_id === undefined ? null : body.account_id;
    if (accountId !== null && (typeof accountId !== "string" || !ACCOUNT.test(accountId))) return reply(400, { error: "account_id is a Zernio account id" });
    const z = await reader();
    if (!z) return reply(424, { error: "zernio_key_missing", secret: ZERNIO_KEY_SECRET });
    try {
      const profiles = await z.profiles();
      const r = await resolveAccount(z, clientId, accountId as string | null);
      if ("refusal" in r) return r.refusal!;
      const owner = r.pageId ? await store.pageOwner(r.pageId, clientId) : null;
      const list = await z.analyticsPage({ accountId: r.chosen._id, fromDate: fromDate(), page: 1, limit: sample as number });
      const posts = list.posts ?? [];
      const mapped: Mapped[] = posts.map((p) => mapPost(p, r.chosen._id));
      const blockers = [
        !r.pageId && "Zernio names no Page for this account.",
        r.pageId && !r.pageMatch && "The account's platform id and its selected Page differ.",
        owner && `Page ${r.pageId} is recorded for another client.`,
        r.recorded?.external_account_id && r.pageId && r.recorded.external_account_id !== r.pageId &&
          `This client's recorded Facebook Page is ${r.recorded.external_account_id}, not ${r.pageId}.`,
        r.hasAnalyticsAccess === false && "Zernio reports no analytics access for this key's account (metrics would be missing).",
      ].filter(Boolean) as string[];
      return reply(200, {
        mode: "plan",
        writes: "none",
        client: { id: client.id, name: client.name },
        key: {
          secret: ZERNIO_KEY_SECRET,
          visible_profiles: profiles.map((p) => ({ id: p._id, name: p.name ?? null, account_count: p.accountCount ?? null })),
          visible_facebook_accounts: r.accounts.map(accountView),
          has_analytics_access: r.hasAnalyticsAccess,
        },
        account: accountView(r.chosen),
        page: {
          id: r.pageId, name: r.pageName, selected_page_id: r.page.selectedPageId ?? null,
          platform_user_id: r.chosen.platformUserId ?? null, match: r.pageMatch,
          recorded_for_client: r.recorded?.external_account_id ?? null,
        },
        listing: {
          from_date: fromDate(),
          available: list.pagination?.total ?? null,
          pages_at_100: list.pagination?.total != null ? Math.ceil(list.pagination.total / 100) : null,
          sample_requested: sample,
          overview: list.overview ?? null,
        },
        field_quality: fieldReport(posts, mapped),
        blockers,
        posts: posts.map((p, i) => {
          const m = mapped[i];
          return m.ok
            ? { zernio: p, would_store: m.row, notes: m.notes }
            : { zernio: p, skipped: m.reason };
        }),
        import_request: blockers.length ? null : {
          mode: "import", client_id: clientId, account_id: r.chosen._id, page_id: r.pageId,
          limit: Math.min(IMPORT_LIMIT.max, Math.max(1, list.pagination?.total ?? IMPORT_LIMIT.default)),
        },
      });
    } catch (e) {
      return zernioReply(e);
    }
  }

  // The background half of an import. Never throws: an exception finishes
  // the import failed (or partial when Zernio was only temporarily unable).
  async function execute(z: ZernioReader, importId: string, accountId: string, limit: number): Promise<void> {
    let oldest: string | null = null;
    let skipped = 0;
    let seen = 0;
    let pages = 0;
    let total: number | null = null;
    let access: boolean | null = null;
    const sync: Record<string, number> = {};
    const state = () => ({ has_analytics_access: access, available: total, pages_read: pages, sync_status: sync, oldest_seen: oldest });
    try {
      const perPage = Math.min(100, limit);
      let complete = false;
      for (let page = 1; seen < limit; page++) {
        const list = await z.analyticsPage({ accountId, fromDate: fromDate(), page, limit: perPage });
        pages++;
        total = list.pagination?.total ?? total;
        if (typeof list.hasAnalyticsAccess === "boolean") access = list.hasAnalyticsAccess;
        const posts = (list.posts ?? []).slice(0, limit - seen);
        if (!posts.length) { complete = true; break; }
        const rows: PostRow[] = [];
        for (const p of posts) {
          const m = mapPost(p, accountId);
          if (!m.ok) { skipped++; continue; }
          rows.push(m.row);
          const s = m.row.metrics ? "synced" : String(p.platforms?.find((x) => x.accountId === accountId)?.syncStatus ?? "missing");
          sync[s] = (sync[s] ?? 0) + 1;
          if (!oldest || m.row.published_at < oldest) oldest = m.row.published_at;
        }
        for (let i = 0; i < rows.length; i += BATCH) await store.record(importId, rows.slice(i, i + BATCH));
        seen += posts.length;
        // Zernio's pagination decides; a short page ends the listing only when it gives none.
        const last = list.pagination?.pages ? page >= list.pagination.pages : (list.posts ?? []).length < perPage;
        if (last) { complete = true; break; }
      }
      // Newest first: everything newer than the oldest post seen was listed.
      await store.finish(importId, "completed", null, { complete: complete || seen >= limit, oldest_seen: oldest, skipped, provider_state: state() });
    } catch (e) {
      const transient = e instanceof ZernioError && e.transient;
      try {
        await store.finish(importId, transient && seen > 0 ? "partial" : "failed", safe(e),
          { complete: false, oldest_seen: oldest, skipped, provider_state: state() });
      } catch { /* the next begin fails an import left running over 30 minutes */ }
    }
  }

  async function importMode(clientId: string, body: Json, memberId: string): Promise<Response> {
    const { account_id: accountId, page_id: pageId } = body;
    const limit = body.limit === undefined ? IMPORT_LIMIT.default : body.limit;
    if (typeof accountId !== "string" || !ACCOUNT.test(accountId)) return reply(400, { error: "account_id (from the plan) is required" });
    if (typeof pageId !== "string" || !/^\d{5,30}$/.test(pageId)) return reply(400, { error: "page_id (from the plan) is required" });
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > IMPORT_LIMIT.max) {
      return reply(400, { error: `limit is a whole number from 1 to ${IMPORT_LIMIT.max}` });
    }
    const z = await reader();
    if (!z) return reply(424, { error: "zernio_key_missing", secret: ZERNIO_KEY_SECRET });
    let r;
    try {
      r = await resolveAccount(z, clientId, accountId);
    } catch (e) {
      return zernioReply(e);
    }
    if ("refusal" in r) return r.refusal!;
    // Bound to the plan: Zernio must still name exactly this Page.
    if (!r.pageMatch || r.pageId !== pageId) {
      return reply(409, { error: "page_mismatch", message: "Zernio no longer names this Page for the account; run the plan again.",
        expected_page_id: pageId, zernio_page_id: r.pageId });
    }
    const begun = await store.begin({
      clientId, pageId, pageName: r.pageName, providerAccountId: accountId, limit: limit as number,
      windowFrom: new Date(now().getTime() - WINDOW_DAYS * 86_400_000).toISOString(), requestedBy: memberId,
    });
    if ("conflict" in begun) {
      return reply(409, { error: begun.conflict === "running" ? "import_running" : begun.conflict, message: begun.message });
    }
    waitUntil(execute(z, begun.import_id, accountId, limit as number));
    return reply(202, { import_id: begun.import_id, social_account_id: begun.social_account_id, limit });
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const who = await store.caller(jwt);
    if (who === "none") return reply(401, { error: "unauthorized" });
    if (!who.member) return reply(403, { error: "forbidden" });
    const body = (await req.json().catch(() => null)) as Json | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "JSON body required" });
    const mode = body.mode;

    if (mode === "version") {
      return reply(200, {
        version: HANDLER_VERSION, modes: MODES, platforms: ["facebook"],
        zernio: { methods: ["GET"], allowlist: ZERNIO_GET_ALLOWLIST.map((r) => ({ path: r.path.source, query: r.query })) },
        key_present: !!(await store.secret(ZERNIO_KEY_SECRET)), secret: ZERNIO_KEY_SECRET,
        limits: { plan_sample: PLAN_SAMPLE, import_limit: IMPORT_LIMIT, batch: BATCH, window_days: WINDOW_DAYS },
      });
    }
    if (mode !== "plan" && mode !== "import") return reply(400, { error: `mode is one of ${MODES.join(", ")}` });
    const allowed = mode === "plan" ? ["mode", "client_id", "sample", "account_id"] : ["mode", "client_id", "account_id", "page_id", "limit"];
    const extra = Object.keys(body).filter((k) => !allowed.includes(k));
    if (extra.length) return reply(400, { error: `unexpected field(s): ${extra.join(", ")}` });
    const clientId = body.client_id;
    if (typeof clientId !== "string" || !UUID.test(clientId)) return reply(400, { error: "client_id (a uuid) is required" });
    if (mode === "import" && who.role !== "admin") return reply(403, { error: "admin_only", message: "Only an admin starts an import." });
    const client = await store.client(clientId);
    if (!client) return reply(404, { error: "client_not_found" });
    if (client.status === "offboarded") return reply(409, { error: "client_offboarded" });
    return mode === "plan" ? await plan(clientId, body, client) : await importMode(clientId, body, who.member);
  }

  return { handle, execute };
}
