// A fake Zernio for the social-history tests, answering the four GET paths
// Compass uses with bodies shaped like Zernio's OpenAPI v1.240.0
// (GET /v1/profiles, /v1/accounts, /v1/accounts/{id}/facebook-page,
// /v1/analytics list form). Every identifier and every word is fictional.
// It records each request it receives, so tests can assert what was sent;
// anything but a GET on a known path answers 405 and is recorded as a
// violation.

export const FAKE_KEY = "sk_" + "0".repeat(64);
export const ACCOUNT = "a1b2c3d4e5f6a1b2c3d4e5f6";
export const OTHER_ACCOUNT = "f6e5d4c3b2a1f6e5d4c3b2a1";
export const PAGE = "100200300400500";
export const PROFILE = "650000000000000000000001";

const day = (n) => new Date(Date.UTC(2026, 9, 7, 15) - n * 86_400_000).toISOString();

// One fictional post in Zernio's list shape.
export function zPost(n, o = {}) {
  const pid = `${PAGE}_${9000 + n}`;
  const synced = o.syncStatus ?? "synced";
  const analytics = o.analytics ?? { impressions: 400 + n, reach: 300 + n, likes: 20 + n, comments: 3, shares: 1, saves: 0,
    clicks: 5, views: 0, engagementRate: 7.9, lastUpdated: "2026-10-07T12:00:00.000Z" };
  return {
    _id: `ext${String(n).padStart(21, "0")}`,
    latePostId: o.latePostId ?? null,
    content: o.content ?? `Another roof finished in Fictionville this week, post ${n}. Thanks to the crew! 🏠`,
    scheduledFor: day(n),
    publishedAt: o.publishedAt === undefined ? day(n) : o.publishedAt,
    status: "published",
    analytics,
    platforms: o.platforms ?? [{
      platform: "facebook", status: "published", platformPostId: o.platformPostId === undefined ? pid : o.platformPostId,
      accountId: o.accountId ?? ACCOUNT, accountUsername: "fictional.roofing", analytics: synced === "synced" ? analytics : null,
      syncStatus: synced, platformPostUrl: o.url === undefined ? `https://www.facebook.com/${PAGE}/posts/${9000 + n}` : o.url,
      errorMessage: null, errorCode: o.errorCode ?? null, isOwner: o.isOwner ?? true,
    }],
    platform: "facebook",
    platformPostUrl: o.url === undefined ? `https://www.facebook.com/${PAGE}/posts/${9000 + n}` : o.url,
    isExternal: true,
    isAd: o.isAd ?? false,
    profileId: PROFILE,
    thumbnailUrl: o.mediaType === "text" ? null : `https://media.zernio.example/thumb/${n}.jpg`,
    mediaType: o.mediaType ?? "image",
    mediaItems: o.mediaItems ?? (o.mediaType === "text" ? [] : [{ type: "image", url: `https://media.zernio.example/${n}.jpg`,
      thumbnail: `https://media.zernio.example/${n}.jpg`, altText: "" }]),
  };
}

export function fakeZernio(o = {}) {
  const requests = [];
  const violations = [];
  const posts = o.posts ?? Array.from({ length: 30 }, (_, i) => zPost(i + 1));
  const accounts = o.accounts ?? [{
    _id: ACCOUNT, platform: "facebook", profileId: { _id: PROFILE, name: "Compass – Fictional Roofing" },
    username: "fictional.roofing", displayName: "Fictional Roofing Co", platformUserId: PAGE,
    profileUrl: `https://www.facebook.com/${PAGE}`, isActive: true, needsReconnection: false, enabled: true,
  }];
  let rateLimitOnce = o.rateLimitOnPage ?? null;
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  async function fetch(input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.get("authorization"), hasBody: req.body !== null };
    requests.push(rec);
    if (req.method !== "GET" || rec.hasBody || url.origin !== "https://zernio.com") {
      violations.push(rec);
      return json(405, { error: "method_not_allowed" });
    }
    if (rec.auth !== `Bearer ${o.key ?? FAKE_KEY}`) return json(401, { error: "Invalid API key" });
    if (o.status) return json(o.status, { error: o.error ?? "error" });
    const p = url.pathname.replace(/^\/api/, "");
    if (p === "/v1/profiles") return json(200, { profiles: [{ _id: PROFILE, name: "Compass – Fictional Roofing", accountCount: accounts.length }] });
    if (p === "/v1/accounts") return json(200, { accounts, hasAnalyticsAccess: o.hasAnalyticsAccess ?? true, pagination: { page: 1, limit: 100, total: accounts.length, pages: 1 } });
    const fb = /^\/v1\/accounts\/([0-9a-f]{24})\/facebook-page$/.exec(p);
    if (fb) {
      if (!accounts.some((a) => a._id === fb[1])) return json(404, { error: "Account not found" });
      return json(200, { pages: [{ id: o.selectedPageId ?? PAGE, name: "Fictional Roofing Co", category: "Roofing Service" }], selectedPageId: o.selectedPageId ?? PAGE, cached: true });
    }
    if (p === "/v1/analytics") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (rateLimitOnce === page) { rateLimitOnce = null; return json(429, { error: "Too many requests" }, { "retry-after": String(o.retryAfter ?? 60) }); }
      const slice = posts.slice((page - 1) * limit, page * limit);
      return json(200, {
        overview: { totalPosts: posts.length, publishedPosts: posts.length, scheduledPosts: 0, lastSync: "2026-10-07T12:00:00.000Z" },
        posts: slice,
        pagination: { page, limit, total: posts.length, pages: Math.max(1, Math.ceil(posts.length / limit)) },
        accounts,
        hasAnalyticsAccess: o.hasAnalyticsAccess ?? true,
      });
    }
    return json(404, { error: "Not found" });
  }
  return { fetch, requests, violations, posts, accounts };
}
