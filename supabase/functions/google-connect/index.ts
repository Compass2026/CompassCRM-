// google-connect — the Connect Google button on Settings.
//
// google-ops does the worker's Google writes with one refresh token for the
// Compass Workspace account (GOOGLE_OPS_REFRESH_TOKEN) plus GA4_ACCOUNT_ID.
// This function mints and stores them from the browser so nothing is pasted
// into a chat or a dashboard:
//
//   POST { mode: "start", return_to }      team JWT → { url } for Google's
//                                          consent screen. State is a signed,
//                                          10-minute nonce carrying return_to.
//   GET  ?code=&state=                     Google's redirect (no JWT — this
//                                          function is deployed with
//                                          verify_jwt = false and the state
//                                          signature is the auth). Exchanges
//                                          the code, stores the refresh token
//                                          via set_secret(), records the account
//                                          email + granted scopes on
//                                          app_settings.google_ops, redirects to
//                                          return_to?google=connected|error.
//   POST { mode: "ga4_accounts" }          team JWT → the Analytics accounts the
//                                          token can see [{ id, name }].
//   POST { mode: "ga4_account", id }       team JWT → stores GA4_ACCOUNT_ID.
//   POST { mode: "access" }                team JWT → per client: is there a
//                                          Business Profile location this token
//                                          manages (phone, then name — same
//                                          match as google-ops), a Search
//                                          Console property (via the GSC token),
//                                          a GA4 property recorded. Stored on
//                                          app_settings.google_access and
//                                          returned.
//
// OAuth app: GSC_CLIENT_ID / GSC_CLIENT_SECRET (GOOGLE_OPS_CLIENT_ID / _SECRET
// override, same as google-ops). Its authorized redirect URIs must include
// this function's own URL. Scopes requested: business.manage, analytics.edit,
// gmail.compose, openid, email.

import { createClient } from "npm:@supabase/supabase-js@2";

const SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
  "https://www.googleapis.com/auth/analytics.edit",
  "https://www.googleapis.com/auth/gmail.compose",
  "openid",
  "email",
];
const REQUIRED = SCOPES.slice(0, 3);
const ACCT = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BIZ = "https://mybusinessbusinessinformation.googleapis.com/v1";
const GA = "https://analyticsadmin.googleapis.com/v1beta";
const GSC = "https://www.googleapis.com/webmasters/v3";

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

Deno.serve(async (req) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const secret = async (name: string): Promise<string | null> => {
    const { data } = await supabase.rpc("get_secret", { secret_name: name });
    return (data as string | null) || null;
  };
  const self = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-connect`;
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
      return new Response("This sign-in link has expired or was tampered with. Go back to Settings and press Connect Google again.", { status: 400 });
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
      return back({ google: "error", reason: "Google did not return a refresh token — remove the app at myaccount.google.com/permissions and connect again" });
    }

    const granted: string[] = String(token.scope ?? "").split(" ").filter(Boolean);
    const missing = REQUIRED.filter((s) => !granted.includes(s));

    let email: string | null = null;
    const who = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (who.ok) email = ((await who.json()).email as string | undefined) ?? null;

    const { error: storeError } = await supabase.rpc("set_secret", { secret_name: "GOOGLE_OPS_REFRESH_TOKEN", secret_value: token.refresh_token });
    if (storeError) return back({ google: "error", reason: `Vault write failed: ${storeError.message}`.slice(0, 200) });

    await setting("google_ops", {
      email,
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
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    }).toString();
    return Response.json({ url: consent.toString(), redirect_uri: self });
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
      const accounts = await fetch(`${ACCT}/accounts?pageSize=20`, { headers: { Authorization: `Bearer ${ops}` } });
      const aj = await accounts.json().catch(() => ({}));
      if (!accounts.ok) gbpError = `Business Profile: ${aj.error?.message ?? accounts.status}`;
      for (const a of (aj.accounts ?? []) as { name: string }[]) {
        const locs = await fetch(`${BIZ}/${a.name}/locations?readMask=name,title,phoneNumbers,websiteUri&pageSize=100`, { headers: { Authorization: `Bearer ${ops}` } });
        if (!locs.ok) continue;
        for (const l of ((await locs.json()).locations ?? []) as { name: string; title?: string; phoneNumbers?: { primaryPhone?: string }; websiteUri?: string }[]) {
          gbp.push({ title: l.title ?? "", phone: digits(l.phoneNumbers?.primaryPhone), website: host(l.websiteUri), name: `${a.name}/${l.name}` });
        }
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

    const rows = (clients ?? []).map((c) => {
      const want = digits(c.phone);
      const names = [c.name, c.dba].filter(Boolean).map((n) => String(n).toLowerCase());
      const site = host(c.website_url);
      const hit =
        gbp.find((l) => want && l.phone === want) ??
        gbp.find((l) => names.some((n) => l.title.toLowerCase() === n)) ??
        gbp.find((l) => site && l.website === site) ??
        gbp.find((l) => names.some((n) => l.title.toLowerCase().includes(n)));
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
});
