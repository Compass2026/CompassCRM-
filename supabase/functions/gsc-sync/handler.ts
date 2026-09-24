// GSC sync — pulls Search Console query + page performance (last 28 complete
// days) into gsc_snapshots for every client whose property the Compass
// Google account can see. Matches queries to tracked keywords by text;
// unmatched rows power the "discovered queries" list.
//
// Auth to Google: OAuth refresh token for the Compass Workspace account
// (internal OAuth app). Secrets in Vault: GSC_CLIENT_ID, GSC_CLIENT_SECRET,
// GSC_REFRESH_TOKEN. Triggered monthly by pg_cron (1st, 07:30 UTC) and on
// demand from the app. Optional body: { client_id }.
//
// { client_id, submit_sitemap } (Launch) is a write to Search Console. An
// automated caller (x-cron-secret — the Foundation worker) is refused it
// with status "skipped" unless app_settings.worker_google_ops is
// { enabled: true } (_shared/worker-google.ts); the check runs before the
// token is fetched. The read-only sync is never gated.

import { workerGoogleOpsEnabled, workerGoogleRefusal } from "../_shared/worker-google.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

function apexDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
type Supabase = any;
type Fetch = typeof globalThis.fetch;

// The request handler over its dependencies (index.ts wires the real ones;
// tests pass a fake Supabase and a fake Google).
export function createGscSync(deps: { supabase: Supabase; fetch: Fetch }) {
  const { supabase } = deps;
  const fetch = deps.fetch;
  return async (req: Request): Promise<Response> => {

  const { data: cronSecret } = await supabase.rpc("get_secret", {
    secret_name: "SYNC_CRON_SECRET",
  });
  const isCron =
    req.headers.get("x-cron-secret") &&
    req.headers.get("x-cron-secret") === cronSecret;
  if (!isCron) {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData } = await supabase.auth.getUser(jwt);
    if (!userData?.user) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    // Signed in is not enough once clients have portal logins: team only.
    const { data: member } = await supabase
      .from("team_members")
      .select("id")
      .eq("auth_user_id", userData.user.id)
      .maybeSingle();
    if (!member) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const body = await req.json().catch(() => ({}));
  // Worker Google operations switch: a sitemap submission is a write.
  if (isCron && typeof body.submit_sitemap === "string" && !(await workerGoogleOpsEnabled(supabase))) {
    return Response.json(workerGoogleRefusal("submit_sitemap"), { status: 403 });
  }

  const [clientId_, clientSecret_, refreshToken_] = await Promise.all([
    supabase.rpc("get_secret", { secret_name: "GSC_CLIENT_ID" }),
    supabase.rpc("get_secret", { secret_name: "GSC_CLIENT_SECRET" }),
    supabase.rpc("get_secret", { secret_name: "GSC_REFRESH_TOKEN" }),
  ]);
  const gscClientId = clientId_.data;
  const gscClientSecret = clientSecret_.data;
  const gscRefreshToken = refreshToken_.data;
  if (!gscClientId || !gscClientSecret || !gscRefreshToken) {
    return Response.json(
      {
        error:
          "GSC not configured — set GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN in Vault",
      },
      { status: 500 }
    );
  }

  // Exchange refresh token for an access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: gscClientId,
      client_secret: gscClientSecret,
      refresh_token: gscRefreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!tokenRes.ok) {
    return Response.json(
      { error: `Google token refresh failed: ${await tokenRes.text()}` },
      { status: 502 }
    );
  }
  const { access_token: accessToken } = await tokenRes.json();
  const gauth = { Authorization: `Bearer ${accessToken}` };

  const sitesRes = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: gauth,
  });
  if (!sitesRes.ok) {
    return Response.json(
      { error: `GSC sites list failed: ${sitesRes.status}` },
      { status: 502 }
    );
  }
  const sites: { siteUrl: string; permissionLevel: string }[] =
    (await sitesRes.json()).siteEntry ?? [];

  const onlyClientId: string | null = body.client_id ?? null;

  // Launch: submit a sitemap for one client's property. Synchronous — the
  // caller wants the answer, not a 202.
  if (typeof body.submit_sitemap === "string" && onlyClientId) {
    const { data: c } = await supabase
      .from("clients")
      .select("gsc_property, website_url")
      .eq("id", onlyClientId)
      .single();
    let property: string | null = c?.gsc_property ?? null;
    if (!property) {
      const apex = c?.website_url ? apexDomain(c.website_url) : null;
      const match = apex
        ? sites.find((s) => s.siteUrl === `sc-domain:${apex}`) ??
          sites.find((s) => s.siteUrl.includes(apex))
        : undefined;
      property = match?.siteUrl ?? null;
      if (property) {
        await supabase.from("clients").update({ gsc_property: property }).eq("id", onlyClientId);
      }
    }
    if (!property) {
      return Response.json(
        { error: "no Search Console property for this client — verify one first (Tracking Setup)" },
        { status: 404 }
      );
    }
    const put = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(body.submit_sitemap)}`,
      { method: "PUT", headers: gauth }
    );
    if (!put.ok) {
      return Response.json(
        { error: `sitemap submit failed (${put.status}): ${(await put.text()).slice(0, 300)}` },
        { status: 502 }
      );
    }
    return Response.json({ property, sitemap: body.submit_sitemap, status: "submitted" });
  }

  let clientQuery = supabase
    .from("clients")
    .select("id, name, website_url, gsc_property")
    .neq("status", "offboarded");
  if (onlyClientId) clientQuery = clientQuery.eq("id", onlyClientId);
  const { data: clients, error: clientsError } = await clientQuery;
  if (clientsError) {
    return Response.json({ error: clientsError.message }, { status: 500 });
  }

  // Last 28 complete days (GSC data lags ~2-3 days)
  const end = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const start = new Date(end.getTime() - 27 * 24 * 3600 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const periodStart = fmt(start);
  const periodEnd = fmt(end);

  const job = (async () => {
    const stats = {
      clients_synced: 0,
      rows: 0,
      matched_keywords: 0,
      skipped: [] as string[],
      errors: [] as string[],
    };

    for (const client of clients ?? []) {
      try {
        // Resolve the GSC property
        let property = client.gsc_property;
        if (!property && client.website_url) {
          const apex = apexDomain(client.website_url);
          if (apex) {
            const domainProp = sites.find(
              (s) => s.siteUrl === `sc-domain:${apex}`
            );
            const prefixProp = sites.find((s) => {
              try {
                return (
                  new URL(s.siteUrl).hostname.replace(/^www\./, "") === apex
                );
              } catch {
                return false;
              }
            });
            property = domainProp?.siteUrl ?? prefixProp?.siteUrl ?? null;
            if (property) {
              await supabase
                .from("clients")
                .update({ gsc_property: property })
                .eq("id", client.id);
            }
          }
        }
        if (!property) {
          stats.skipped.push(client.name);
          continue;
        }

        const saRes = await fetch(
          `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
          {
            method: "POST",
            headers: { ...gauth, "Content-Type": "application/json" },
            body: JSON.stringify({
              startDate: periodStart,
              endDate: periodEnd,
              dimensions: ["query", "page"],
              rowLimit: 250,
            }),
          }
        );
        if (!saRes.ok) {
          stats.errors.push(`${client.name}: GSC query ${saRes.status}`);
          continue;
        }
        const rows: {
          keys: [string, string];
          clicks: number;
          impressions: number;
          ctr: number;
          position: number;
        }[] = (await saRes.json()).rows ?? [];

        const { data: kws } = await supabase
          .from("keywords")
          .select("id, keyword")
          .eq("client_id", client.id);
        const kwByText = new Map(
          (kws ?? []).map((k: { id: string; keyword: string }) => [k.keyword.toLowerCase(), k.id])
        );

        const snapRows = rows.map((r) => {
          const kwId = kwByText.get(r.keys[0].toLowerCase()) ?? null;
          if (kwId) stats.matched_keywords++;
          return {
            client_id: client.id,
            keyword_id: kwId,
            query: r.keys[0],
            page: r.keys[1] ?? "",
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: Math.round(r.ctr * 10000) / 10000,
            avg_position: Math.round(r.position * 100) / 100,
            period_start: periodStart,
            period_end: periodEnd,
          };
        });

        if (snapRows.length > 0) {
          const { data: inserted, error } = await supabase
            .from("gsc_snapshots")
            .upsert(snapRows, {
              onConflict: "client_id,query,page,period_start,period_end",
              ignoreDuplicates: true,
            })
            .select("id");
          if (error) stats.errors.push(`${client.name}: ${error.message}`);
          else stats.rows += (inserted ?? []).length;
        }
        stats.clients_synced++;
      } catch (e) {
        stats.errors.push(
          `${client.name}: ${e instanceof Error ? e.message : e}`
        );
      }
    }
  })();

  EdgeRuntime.waitUntil(job);

  return Response.json(
    {
      ok: true,
      started: true,
      clients: (clients ?? []).length,
      properties_visible: sites.length,
      period: { start: periodStart, end: periodEnd },
    },
    { status: 202 }
  );
};
}
