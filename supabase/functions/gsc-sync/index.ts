// GSC sync — pulls Search Console query + page performance (last 28 complete
// days) into gsc_snapshots for every client whose property the Compass
// Google account can see. Matches queries to tracked keywords by text;
// unmatched rows power the "discovered queries" list.
//
// Auth to Google: OAuth refresh token for the Compass Workspace account
// (internal OAuth app). Secrets in Vault: GSC_CLIENT_ID, GSC_CLIENT_SECRET,
// GSC_REFRESH_TOKEN. Triggered monthly by pg_cron (1st, 07:30 UTC) and on
// demand from the app. Optional body: { client_id }.

import { createClient } from "npm:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

function apexDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

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

  const body = await req.json().catch(() => ({}));
  const onlyClientId: string | null = body.client_id ?? null;

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
          (kws ?? []).map((k) => [k.keyword.toLowerCase(), k.id])
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
});
