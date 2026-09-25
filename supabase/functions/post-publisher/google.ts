// Google Business Profile calls for the post publisher. Every call goes
// through the injected fetch (tests pass a fake Google) and times out, so a
// hung request becomes a transient failure rather than a stuck run.

import type { GooglePost } from "./channel.ts";

const BIZ = "https://mybusinessbusinessinformation.googleapis.com/v1";
const V4 = "https://mybusiness.googleapis.com/v4";
export const GOOGLE_TIMEOUT_MS = 20_000;
const LIST_PAGES = 3;

type Fetch = typeof fetch;
export type ClientRow = { id: string; name: string; dba: string | null; phone: string | null; gbp_location: string | null };
export type Location = { account: string; location: string; mapsUri: string | null };
export type Answer = { ok: boolean; status: number | null; json: unknown; text: string };

async function call(f: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Answer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    // Network error or timeout: status null (transient).
    return { ok: false, status: null, json: null, text: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshToken(
  f: Fetch,
  creds: { clientId: string | null; clientSecret: string | null; refreshToken: string | null },
  timeoutMs = GOOGLE_TIMEOUT_MS
): Promise<{ token: string } | { blocked: string }> {
  if (!creds.refreshToken) {
    return { blocked: "Google is not connected: GOOGLE_OPS_REFRESH_TOKEN is not set (Settings → Connect Google)." };
  }
  if (!creds.clientId || !creds.clientSecret) {
    return { blocked: "Google OAuth client is not configured (GSC_CLIENT_ID / GSC_CLIENT_SECRET)." };
  }
  const a = await call(f, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId, client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken, grant_type: "refresh_token",
    }).toString(),
  }, timeoutMs);
  const token = (a.json as { access_token?: string } | null)?.access_token;
  if (!a.ok || !token) return { blocked: `Google token refresh failed (${a.status ?? "network"}): ${a.text.slice(0, 200)}` };
  return { token };
}

export function googleClient(f: Fetch, token: string, timeoutMs = GOOGLE_TIMEOUT_MS) {
  const g = (url: string, init: RequestInit = {}) =>
    call(f, url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    }, timeoutMs);

  // The client's profile, as the token sees it: only the location a person
  // selected and confirmed (google-connect gbp_select stores it on
  // clients.gbp_location). With none recorded the publisher stops with
  // GBP_LOCATION_REQUIRED; it never searches for, picks or stores one.
  async function locate(client: ClientRow): Promise<{ loc: Location } | { blocked: string; code?: "GBP_LOCATION_REQUIRED" }> {
    if (!client.gbp_location) {
      return {
        code: "GBP_LOCATION_REQUIRED",
        blocked: `GBP_LOCATION_REQUIRED: no Business Profile location is selected for "${client.name}". Pick it in Settings → Google hands → Business Profile location per client; the publisher never chooses one itself.`,
      };
    }
    const [account, l] = String(client.gbp_location).split("/locations/");
    const location = `locations/${l}`;
    // Confirm access (and pick up the Maps link as a fallback published URL).
    const check = await g(`${BIZ}/${location}?readMask=name,metadata`);
    if (!check.ok) {
      return { blocked: `The Compass Google account cannot open ${account}/${location} (${check.status ?? "network"}). Check its manager access on the client's profile.` };
    }
    const mapsUri = ((check.json as { metadata?: { mapsUri?: string } })?.metadata?.mapsUri) ?? null;
    return { loc: { account, location, mapsUri } };
  }

  // Up to LIST_PAGES pages of 100. complete is false when Google had more,
  // so a caller never treats "not found in what was read" as "not there".
  async function listPosts(loc: Location): Promise<{ ok: true; posts: GooglePost[]; complete: boolean } | { ok: false; answer: Answer }> {
    const posts: GooglePost[] = [];
    let token: string | null = null;
    for (let page = 0; page < LIST_PAGES; page++) {
      const a = await g(`${V4}/${loc.account}/${loc.location}/localPosts?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
      if (!a.ok) return { ok: false, answer: a };
      const body = (a.json ?? {}) as { localPosts?: GooglePost[]; nextPageToken?: string };
      posts.push(...(body.localPosts ?? []));
      token = body.nextPageToken || null;
      if (!token) return { ok: true, posts, complete: true };
    }
    return { ok: true, posts, complete: false };
  }

  async function createPost(loc: Location, body: Record<string, unknown>): Promise<Answer> {
    return g(`${V4}/${loc.account}/${loc.location}/localPosts`, { method: "POST", body: JSON.stringify(body) });
  }

  return { locate, listPosts, createPost };
}

export function googleMessage(a: Answer): string {
  const msg = (a.json as { error?: { message?: string } } | null)?.error?.message ?? a.text;
  return `Google ${a.status ?? "network error"}: ${String(msg).slice(0, 300)}`;
}
