// google-connect — the Connect Business Profile button on Settings.
//
// Mints the Compass Workspace account's Google credential from the browser so
// nothing is pasted into a chat or a dashboard, and lets a person pick each
// client's Business Profile location explicitly:
//
//   POST { mode: "start", return_to }      team JWT → { url } for Google's
//                                          consent screen. State is a signed,
//                                          10-minute nonce carrying return_to.
//   GET  ?code=&state=                     Google's redirect (no JWT — this
//                                          function is deployed with
//                                          verify_jwt = false and the state
//                                          signature is the auth). Exchanges
//                                          the code; stores the refresh token
//                                          via set_secret() only if Google
//                                          granted Business Profile and nothing
//                                          outside GBP_CONNECT_SCOPES; records
//                                          the account email + granted scopes on
//                                          app_settings.google_ops; redirects to
//                                          return_to?google=connected|partial|error.
//   POST { mode: "gbp_locations", client_id? }
//                                          team JWT → every Business Profile
//                                          location the connected account
//                                          manages, all accounts and all pages,
//                                          with the details a person needs to
//                                          recognise the right one. Read-only:
//                                          GETs to Google, no CRM write. With
//                                          client_id, each candidate carries
//                                          hints (phone / website / exact name)
//                                          — hints only, never a selection.
//   POST { mode: "gbp_select", client_id, location, title, confirm: true }
//                                          team JWT → a person's explicit pick.
//                                          Verifies that exact location with
//                                          Google (get + the account's own
//                                          listing), then stores
//                                          accounts/{a}/locations/{l} on
//                                          clients.gbp_location only while it is
//                                          empty. Never overwrites.
//   POST { mode: "ga4_accounts" }          team JWT → the Analytics accounts the
//                                          token can see (needs analytics scope,
//                                          which the Business Profile connection
//                                          does not request).
//   POST { mode: "ga4_account", id }       team JWT → stores GA4_ACCOUNT_ID.
//   POST { mode: "access" }                team JWT → per client: a Business
//                                          Profile location this token manages,
//                                          a Search Console property (via the
//                                          GSC token), a GA4 property recorded.
//                                          Stored on app_settings.google_access.
//
// Scope (Sept 24 2026): the connection is for Business Profile only —
// openid, email, business.manage — with include_granted_scopes=false, so
// the token never inherits Search Console, Analytics, Gmail or Drive
// grants the same user gave this OAuth app before. The secret keeps its
// name (GOOGLE_OPS_REFRESH_TOKEN) so google-ops and the post publisher read
// it unchanged; google-ops' GA4 and Gmail ops fail on scope and stay Tom's.
// The Search Console token (GSC_REFRESH_TOKEN) is never written here.
//
// Nothing in this function writes to Google: every Google call is a GET
// (plus the OAuth token endpoints). It never touches the Worker Google
// operations switch or the publisher switch and pilot list.
//
// OAuth app: GSC_CLIENT_ID / GSC_CLIENT_SECRET (GOOGLE_OPS_CLIENT_ID / _SECRET
// override). Its authorized redirect URIs must include this function's URL.

export const BUSINESS_MANAGE = "https://www.googleapis.com/auth/business.manage";
export const GBP_CONNECT_SCOPES = ["openid", "email", BUSINESS_MANAGE] as const;
// What Google may answer for the requested set: it reports "email" as the
// userinfo.email URL. Anything else granted means the token is broader than
// asked, and it is not stored.
const ALLOWED_GRANTED = new Set<string>([...GBP_CONNECT_SCOPES, "https://www.googleapis.com/auth/userinfo.email"]);
const REQUIRED = [BUSINESS_MANAGE];

const ACCT = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BIZ = "https://mybusinessbusinessinformation.googleapis.com/v1";
const V4 = "https://mybusiness.googleapis.com/v4";
const GA = "https://analyticsadmin.googleapis.com/v1beta";
const GSC = "https://www.googleapis.com/webmasters/v3";
const LOCATION_READ_MASK = "name,title,phoneNumbers,websiteUri,storefrontAddress,serviceArea,metadata";
export const MAX_PAGES = 50;
const LOCATION_RE = /^accounts\/(\d+)\/locations\/(\d+)$/;

export type GbpCandidate = {
  account: string; // accounts/{a}
  account_name: string | null;
  account_type: string | null;
  location: string; // locations/{l}
  resource: string; // accounts/{a}/locations/{l} — what clients.gbp_location stores
  title: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  service_area: string | null;
  maps_uri: string | null;
  place_id: string | null;
  has_voice_of_merchant: boolean | null;
  hints?: { phone: boolean; website: boolean; exact_name: boolean };
};

type GLocation = {
  name: string;
  title?: string;
  phoneNumbers?: { primaryPhone?: string };
  websiteUri?: string;
  storefrontAddress?: { addressLines?: string[]; locality?: string; administrativeArea?: string; postalCode?: string };
  serviceArea?: { businessType?: string; places?: { placeInfos?: { placeName?: string }[] } };
  metadata?: { mapsUri?: string; placeId?: string; hasVoiceOfMerchant?: boolean };
};

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}
async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))));
}
function digits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
}
function host(u: string | null | undefined): string {
  try {
    return new URL(u ?? "").hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function candidateOf(account: { name: string; accountName?: string; type?: string }, l: GLocation): GbpCandidate {
  const a = l.storefrontAddress;
  const address = a
    ? [...(a.addressLines ?? []), [a.locality, a.administrativeArea].filter(Boolean).join(", "), a.postalCode].filter(Boolean).join(", ") || null
    : null;
  const places = (l.serviceArea?.places?.placeInfos ?? []).map((p) => p.placeName).filter(Boolean);
  const serviceArea = places.length ? places.join("; ") : l.serviceArea?.businessType ?? null;
  return {
    account: account.name,
    account_name: account.accountName ?? null,
    account_type: account.type ?? null,
    location: l.name,
    resource: `${account.name}/${l.name}`,
    title: l.title ?? "",
    phone: l.phoneNumbers?.primaryPhone ?? null,
    website: l.websiteUri ?? null,
    address,
    service_area: serviceArea,
    maps_uri: l.metadata?.mapsUri ?? null,
    place_id: l.metadata?.placeId ?? null,
    has_voice_of_merchant: l.metadata?.hasVoiceOfMerchant ?? null,
  };
}

// deno-lint-ignore no-explicit-any
type Supabase = any;
type Fetch = typeof globalThis.fetch;

// The request handler over its dependencies (index.ts wires the real ones;
// tests pass a fake Supabase and a fake Google). selfUrl is this function's
// public URL — the OAuth redirect URI.
export function createGoogleConnect(deps: { supabase: Supabase; fetch: Fetch; selfUrl: string }) {
  const { supabase, selfUrl: self } = deps;
  const fetch = deps.fetch;
  return async (req: Request): Promise<Response> => {
  const secret = async (name: string): Promise<string | null> => {
    const { data } = await supabase.rpc("get_secret", { secret_name: name });
    return (data as string | null) || null;
  };
  const url = new URL(req.url);

  const signingKey = await secret("SYNC_CRON_SECRET");
  if (!signingKey) return Response.json({ error: "SYNC_CRON_SECRET is not in Vault" }, { status: 500 });
  const clientId = (await secret("GOOGLE_OPS_CLIENT_ID")) ?? (await secret("GSC_CLIENT_ID"));
  const clientSecret = (await secret("GOOGLE_OPS_CLIENT_SECRET")) ?? (await secret("GSC_CLIENT_SECRET"));

  const setting = async (key: string, value: unknown) => {
    await supabase.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() });
  };

  // ── Google's redirect back ──────────────────────────────────────────────
  if (req.method === "GET") {
    const state = url.searchParams.get("state") ?? "";
    const [payloadB64, sig] = state.split(".");
    let payload: { exp: number; return_to: string; nonce: string } | null = null;
    try {
      if (payloadB64 && sig && (await hmac(signingKey, payloadB64)) === sig) {
        payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
      }
    } catch {
      payload = null;
    }
    if (!payload || payload.exp < Date.now()) {
      return new Response("This sign-in link has expired or was tampered with. Go back to Settings and press Connect Business Profile again.", { status: 400 });
    }
    const back = (params: Record<string, string>) => {
      const to = new URL(payload!.return_to);
      for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
      return Response.redirect(to.toString(), 302);
    };

    const denied = url.searchParams.get("error");
    if (denied) return back({ google: "error", reason: denied });
    const code = url.searchParams.get("code");
    if (!code) return back({ google: "error", reason: "no code returned" });
    if (!clientId || !clientSecret) return back({ google: "error", reason: "GSC_CLIENT_ID / GSC_CLIENT_SECRET are not in Vault" });

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: self, grant_type: "authorization_code" }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      return back({ google: "error", reason: (token.error_description ?? token.error ?? `token exchange ${tokenRes.status}`).slice(0, 200) });
    }
    if (!token.refresh_token) {
      return back({ google: "error", reason: "Google did not return a refresh token. Press Connect Business Profile again" });
    }

    const granted: string[] = String(token.scope ?? "").split(" ").filter(Boolean);
    const missing = REQUIRED.filter((s) => !granted.includes(s));
    const extra = granted.filter((s) => !ALLOWED_GRANTED.has(s));
    // Broader than asked: do not keep it. (Not revoked here — revoking the
    // grant would also end the Search Console token if the same user
    // minted it on this OAuth app.)
    if (extra.length) {
      return back({ google: "error", reason: `Google granted more than Business Profile (${extra.map((s) => s.split("/").pop()).join(", ")}); the token was not stored` });
    }

    let email: string | null = null;
    const who = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (who.ok) email = ((await who.json()).email as string | undefined) ?? null;

    const { error: storeError } = await supabase.rpc("set_secret", { secret_name: "GOOGLE_OPS_REFRESH_TOKEN", secret_value: token.refresh_token });
    if (storeError) return back({ google: "error", reason: `Vault write failed: ${storeError.message}`.slice(0, 200) });

    await setting("google_ops", {
      email,
      purpose: "business_profile",
      requested_scopes: [...GBP_CONNECT_SCOPES],
      scopes: granted,
      missing_scopes: missing,
      connected_at: new Date().toISOString(),
    });
    return back(missing.length ? { google: "partial", reason: `missing ${missing.map((s) => s.split("/").pop()).join(", ")}` } : { google: "connected" });
  }

  // ── Everything else needs a team JWT ────────────────────────────────────
  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  const { data: userData } = await supabase.auth.getUser(jwt);
  if (!userData?.user) return Response.json({ error: "unauthorized" }, { status: 401 });
  // Signed in is not enough once clients have portal logins: team only.
  const { data: member } = await supabase.from("team_members").select("id").eq("auth_user_id", userData.user.id).maybeSingle();
  if (!member) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const mode: string = body?.mode ?? "";

  if (mode === "start") {
    if (!clientId) return Response.json({ error: "GSC_CLIENT_ID is not in Vault — the Google OAuth app google-connect reuses." }, { status: 500 });
    let returnTo: URL;
    try {
      returnTo = new URL(body.return_to);
      if (returnTo.protocol !== "https:" && returnTo.hostname !== "localhost") throw new Error();
    } catch {
      return Response.json({ error: "return_to must be an https URL" }, { status: 400 });
    }
    const payload = b64url(new TextEncoder().encode(JSON.stringify({
      exp: Date.now() + 10 * 60 * 1000,
      return_to: returnTo.toString(),
      nonce: crypto.randomUUID(),
    })));
    const state = `${payload}.${await hmac(signingKey, payload)}`;
    const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    consent.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: self,
      response_type: "code",
      scope: GBP_CONNECT_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
    }).toString();
    return Response.json({ url: consent.toString(), redirect_uri: self, scopes: [...GBP_CONNECT_SCOPES] });
  }

  // The remaining modes use the stored ops token.
  const accessToken = async (refreshName: string): Promise<string | { error: string }> => {
    const refresh = await secret(refreshName);
    if (!refresh || !clientId || !clientSecret) return { error: `${refreshName} is not in Vault` };
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) return { error: `Google refused the ${refreshName}: ${(json.error_description ?? json.error ?? res.status)}`.slice(0, 200) };
    return json.access_token as string;
  };
  const getJson = async (tok: string, u: string) => {
    const res = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : `${json?.error?.message ?? res.status}` };
  };

  // Every page of accounts, then every page of each account's locations.
  // GET only. complete is false when a page cap was hit or a listing failed,
  // so "not in the list" is never read as "not there".
  const listLocations = async (tok: string) => {
    const accounts: { name: string; accountName?: string; type?: string }[] = [];
    const errors: string[] = [];
    let complete = true;
    let pageToken: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) { complete = false; errors.push(`accounts: stopped after ${MAX_PAGES} pages`); break; }
      const r = await getJson(tok, `${ACCT}/accounts?pageSize=20${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
      if (!r.ok) return { accounts, candidates: [] as GbpCandidate[], errors: [`Business Profile accounts: ${r.error}`], complete: false, fatal: true };
      accounts.push(...(r.json.accounts ?? []));
      pageToken = r.json.nextPageToken || null;
      if (!pageToken) break;
    }
    const candidates: GbpCandidate[] = [];
    for (const a of accounts) {
      let locToken: string | null = null;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) { complete = false; errors.push(`${a.name}: stopped after ${MAX_PAGES} pages`); break; }
        const r = await getJson(tok, `${BIZ}/${a.name}/locations?readMask=${LOCATION_READ_MASK}&pageSize=100${locToken ? `&pageToken=${encodeURIComponent(locToken)}` : ""}`);
        if (!r.ok) { complete = false; errors.push(`${a.name} locations: ${r.error}`); break; }
        for (const l of (r.json.locations ?? []) as GLocation[]) candidates.push(candidateOf(a, l));
        locToken = r.json.nextPageToken || null;
        if (!locToken) break;
      }
    }
    return { accounts, candidates, errors, complete, fatal: false };
  };

  if (mode === "gbp_locations") {
    const tok = await accessToken("GOOGLE_OPS_REFRESH_TOKEN");
    if (typeof tok !== "string") return Response.json({ error: tok.error }, { status: 200 });
    const listed = await listLocations(tok);
    if (listed.fatal) return Response.json({ error: listed.errors[0] }, { status: 200 });
    let candidates = listed.candidates;
    if (body.client_id) {
      const { data: client } = await supabase.from("clients").select("id, name, dba, phone, website_url").eq("id", body.client_id).maybeSingle();
      if (client) {
        const want = digits(client.phone);
        const site = host(client.website_url);
        const names = [client.name, client.dba].filter(Boolean).map((n: string) => String(n).trim().toLowerCase());
        candidates = candidates.map((c) => ({
          ...c,
          hints: {
            phone: !!want && digits(c.phone) === want,
            website: !!site && host(c.website) === site,
            exact_name: names.includes(c.title.trim().toLowerCase()),
          },
        }));
      }
    }
    return Response.json({
      accounts: listed.accounts.length,
      candidates,
      complete: listed.complete,
      errors: listed.errors,
    });
  }

  if (mode === "gbp_select") {
    const clientIdIn = String(body.client_id ?? "");
    const resource = String(body.location ?? "").trim();
    const shownTitle = typeof body.title === "string" ? body.title : null;
    const m = LOCATION_RE.exec(resource);
    if (!clientIdIn || !m) {
      return Response.json({ error: "Pick a listed location: client_id and location (accounts/{id}/locations/{id}) are required." }, { status: 400 });
    }
    if (body.confirm !== true || shownTitle === null) {
      return Response.json({ error: "Confirm that this is the client's own Business Profile before saving." }, { status: 400 });
    }
    const { data: client, error: clientError } = await supabase.from("clients").select("id, name, gbp_location").eq("id", clientIdIn).maybeSingle();
    if (clientError || !client) return Response.json({ error: clientError?.message ?? "client not found" }, { status: 404 });
    if (client.gbp_location) {
      return Response.json(
        client.gbp_location === resource
          ? { ok: true, unchanged: true, location: resource, detail: `${client.name} already uses this location.` }
          : { error: `${client.name} already has a Business Profile location (${client.gbp_location}). It is never overwritten from here; clear it deliberately first.` },
        { status: client.gbp_location === resource ? 200 : 409 }
      );
    }

    const tok = await accessToken("GOOGLE_OPS_REFRESH_TOKEN");
    if (typeof tok !== "string") return Response.json({ error: tok.error }, { status: 502 });
    const account = `accounts/${m[1]}`;
    const location = `locations/${m[2]}`;

    // 1. The location itself, as the connected account sees it now.
    const got = await getJson(tok, `${BIZ}/${location}?readMask=${LOCATION_READ_MASK}`);
    if (!got.ok || got.json?.name !== location) {
      return Response.json({ error: `Google could not open ${resource} for the connected account (${got.error ?? "unexpected answer"}). Nothing was saved.` }, { status: 409 });
    }
    const title = String(got.json.title ?? "");
    if (title !== shownTitle) {
      return Response.json({ error: `The profile's name is now "${title}", not "${shownTitle}" as listed. List the locations again and re-check. Nothing was saved.` }, { status: 409 });
    }
    // 2. It belongs to that account (the posts API addresses it through it).
    let inAccount = false;
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES && !inAccount; page++) {
      const r = await getJson(tok, `${BIZ}/${account}/locations?readMask=name&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
      if (!r.ok) break;
      inAccount = ((r.json.locations ?? []) as { name: string }[]).some((l) => l.name === location);
      pageToken = r.json.nextPageToken || null;
      if (!pageToken) break;
    }
    if (!inAccount) {
      return Response.json({ error: `${location} is not listed under ${account} for the connected account. Nothing was saved.` }, { status: 409 });
    }

    // 3. Save, only while empty.
    const { data: saved, error: saveError } = await supabase
      .from("clients")
      .update({ gbp_location: resource })
      .eq("id", client.id)
      .is("gbp_location", null)
      .select("id");
    if (saveError) return Response.json({ error: saveError.message }, { status: 500 });
    if (!saved?.length) {
      return Response.json({ error: `${client.name}'s Business Profile location was set by someone else meanwhile. Nothing was overwritten.` }, { status: 409 });
    }

    // 4. Read-only check of the posts listing (nothing is created).
    const posts = await getJson(tok, `${V4}/${resource}/localPosts?pageSize=1`);
    const verified = candidateOf({ name: account }, got.json as GLocation);
    return Response.json({
      ok: true,
      location: resource,
      verified,
      posts_readable: posts.ok,
      posts_error: posts.ok ? null : posts.error,
      detail: `${client.name} → ${title} (${resource}) saved.`,
    });
  }

  if (mode === "ga4_accounts") {
    const tok = await accessToken("GOOGLE_OPS_REFRESH_TOKEN");
    if (typeof tok !== "string") return Response.json(tok, { status: 200 });
    const res = await fetch(`${GA}/accountSummaries?pageSize=200`, { headers: { Authorization: `Bearer ${tok}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return Response.json({ error: `Analytics Admin: ${json.error?.message ?? res.status}` }, { status: 200 });
    const accounts = ((json.accountSummaries ?? []) as { account: string; displayName: string; propertySummaries?: unknown[] }[]).map((a) => ({
      id: a.account.replace("accounts/", ""),
      name: a.displayName,
      properties: a.propertySummaries?.length ?? 0,
    }));
    return Response.json({ accounts });
  }

  if (mode === "ga4_account") {
    const id = String(body.id ?? "").replace(/^accounts\//, "").trim();
    if (!/^\d+$/.test(id)) return Response.json({ error: "id must be the numeric Analytics account id" }, { status: 400 });
    const { error } = await supabase.rpc("set_secret", { secret_name: "GA4_ACCOUNT_ID", secret_value: id });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    await setting("ga4_account", { id, name: body.name ?? null, set_at: new Date().toISOString() });
    return Response.json({ ok: true, id });
  }

  if (mode === "access") {
    const { data: clients } = await supabase
      .from("clients")
      .select("id, name, dba, phone, website_url, gsc_property, gbp_location, ga4_property, status")
      .not("status", "in", "(paused,offboarded)")
      .order("name");

    // Business Profile locations this token manages, one listing for all clients.
    const gbp: { title: string; phone: string; website: string; name: string }[] = [];
    let gbpError: string | null = null;
    const ops = await accessToken("GOOGLE_OPS_REFRESH_TOKEN");
    if (typeof ops !== "string") gbpError = ops.error;
    else {
      const listed = await listLocations(ops);
      if (listed.fatal) gbpError = listed.errors[0];
      for (const c of listed.candidates) {
        gbp.push({ title: c.title, phone: digits(c.phone), website: host(c.website), name: c.resource });
      }
    }

    // Search Console properties, via the token gsc-sync already holds.
    let gscSites: string[] = [];
    let gscError: string | null = null;
    const gscTok = await accessToken("GSC_REFRESH_TOKEN");
    if (typeof gscTok !== "string") gscError = gscTok.error;
    else {
      const res = await fetch(`${GSC}/sites`, { headers: { Authorization: `Bearer ${gscTok}` } });
      const sj = await res.json().catch(() => ({}));
      if (!res.ok) gscError = `Search Console: ${sj.error?.message ?? res.status}`;
      gscSites = ((sj.siteEntry ?? []) as { siteUrl: string; permissionLevel: string }[])
        .filter((s) => s.permissionLevel !== "siteUnverifiedUser")
        .map((s) => s.siteUrl);
    }

    // A report only: it never writes clients.gbp_location (gbp_select does).
    const rows = (clients ?? []).map((c: { id: string; name: string; dba: string | null; phone: string | null; website_url: string | null; gsc_property: string | null; gbp_location: string | null; ga4_property: string | null }) => {
      const want = digits(c.phone);
      const names = [c.name, c.dba].filter(Boolean).map((n) => String(n).toLowerCase());
      const site = host(c.website_url);
      const hit =
        (c.gbp_location ? gbp.find((l) => l.name === c.gbp_location) : undefined) ??
        gbp.find((l) => want && l.phone === want) ??
        gbp.find((l) => names.some((n) => l.title.toLowerCase() === n)) ??
        gbp.find((l) => site && l.website === site);
      const gsc = c.gsc_property
        ? gscSites.includes(c.gsc_property)
        : gscSites.some((s) => s === `sc-domain:${site}` || host(s) === site);
      return {
        id: c.id,
        name: c.name,
        gbp: hit ? "yes" : gbpError ? "unknown" : "no",
        gbp_title: hit?.title ?? null,
        gsc: gsc ? "yes" : gscError ? "unknown" : site ? "no" : "n/a",
        ga4: c.ga4_property ? "yes" : "no",
      };
    });
    const result = { checked_at: new Date().toISOString(), gbp_error: gbpError, gsc_error: gscError, locations: gbp.length, clients: rows };
    await setting("google_access", result);
    return Response.json(result);
  }

  return Response.json({ error: "unknown mode" }, { status: 400 });
};
}
