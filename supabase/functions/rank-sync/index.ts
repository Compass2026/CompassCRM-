// rank-sync — weekly rank checks for every tracked keyword through
// DataForSEO's live Google SERP endpoint. Replaces BrightLocal's Local Rank
// Tracker as the source of organic + map-pack positions (BrightLocal stays
// for the 7×7 grids); the monthly BrightLocal sync is untouched.
//
// Per active / launching client with tracked keywords: one SERP task per
// keyword at the keyword's city (else the client's home city), desktop,
// depth 100, in batches of up to 100 tasks per call. The client's site host
// (sites.url, else clients.website_url) gives the organic position; the host
// or the business name gives the map-pack position. Results land in
// rank_snapshots (source 'dataforseo', one row per keyword × location ×
// result type × run date; the natural-key index makes a re-run a no-op),
// keywords.last_checked is stamped, rank_runs records the run, and the City
// Index is recomputed for the month.
//
// Secrets (Vault): DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD. Without them the
// function answers { skipped } and nothing breaks.
// Auth: a team JWT or the x-cron-secret header. Body: { client_id? ,
// triggered_by? } — one client, or every client. Responds 202 and finishes
// in the background (EdgeRuntime.waitUntil); the run rows carry progress.

import { createClient } from "npm:@supabase/supabase-js@2";

const DFS = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const BATCH = 100;

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

function stateName(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return STATES[t.toUpperCase()] ?? (Object.values(STATES).find((n) => n.toLowerCase() === t.toLowerCase()) ?? null);
}

function host(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

type Item = { type: string; rank_group?: number; rank_absolute?: number; domain?: string; url?: string; title?: string };

Deno.serve(async (req) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const secret = async (name: string): Promise<string | null> => {
    const { data } = await supabase.rpc("get_secret", { secret_name: name });
    return (data as string | null) || null;
  };

  const cronSecret = await secret("SYNC_CRON_SECRET");
  const isCron = req.headers.get("x-cron-secret") && req.headers.get("x-cron-secret") === cronSecret;
  if (!isCron) {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData } = await supabase.auth.getUser(jwt);
    if (!userData?.user) return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const triggeredBy = body.triggered_by === "cron" ? "cron" : "manual";

  const login = await secret("DATAFORSEO_LOGIN");
  const password = await secret("DATAFORSEO_PASSWORD");
  if (!login || !password) {
    return Response.json(
      { ok: false, skipped: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not in Vault — the API login and password from app.dataforseo.com/api-access." },
      { status: 200 }
    );
  }
  const auth = "Basic " + btoa(`${login}:${password}`);

  let clientQuery = supabase
    .from("clients")
    .select("id, name, dba, city, state, website_url, sites(url, controlled_by_compass)")
    .in("status", ["active", "launching"]);
  if (body.client_id) clientQuery = clientQuery.eq("id", body.client_id);
  const { data: clients, error: clientError } = await clientQuery;
  if (clientError) return Response.json({ error: clientError.message }, { status: 500 });

  const recordedAt = new Date().toISOString();
  const period = recordedAt.slice(0, 7) + "-01";
  const runIds = new Map<string, string>();
  const work: { client: NonNullable<typeof clients>[number]; keywords: { id: string; keyword: string; city: string | null }[] }[] = [];
  for (const c of clients ?? []) {
    const { data: kws } = await supabase
      .from("keywords")
      .select("id, keyword, city")
      .eq("client_id", c.id)
      .eq("is_active", true)
      .eq("is_tracked", true);
    if (!kws?.length) continue;
    const { data: run } = await supabase
      .from("rank_runs")
      .insert({ client_id: c.id, triggered_by: triggeredBy, status: "running" })
      .select("id")
      .single();
    if (run) runIds.set(c.id, run.id);
    work.push({ client: c, keywords: kws });
  }

  const job = (async () => {
    const totals = { clients: 0, keywords: 0, snapshots: 0, cost: 0, errors: [] as string[] };

    for (const { client, keywords } of work) {
      const runId = runIds.get(client.id) ?? null;
      const stats = { keywords: keywords.length, snapshots: 0, cost: 0, errors: [] as string[] };
      try {
        // ── Locations: the home row plus one per keyword city ─────────
        const { data: locs } = await supabase
          .from("locations")
          .select("id, name, city, state, is_physical_location, sort_order")
          .eq("client_id", client.id)
          .eq("is_active", true)
          .order("is_physical_location", { ascending: false })
          .order("sort_order");
        let home = (locs ?? []).find((l) => norm(l.city) === norm(client.city)) ?? (locs ?? [])[0] ?? null;
        if (!home) {
          const { data: created } = await supabase
            .from("locations")
            .insert({ client_id: client.id, name: client.name, city: client.city, state: client.state, is_physical_location: false })
            .select("id, name, city, state, is_physical_location, sort_order")
            .single();
          home = created;
        }
        if (!home) throw new Error("no home location and could not create one");
        const byCity = new Map<string, string>();
        for (const l of locs ?? []) if (l.city) byCity.set(norm(l.city), l.id);
        const locationFor = async (city: string | null): Promise<string> => {
          if (!city || norm(city) === norm(client.city)) return home!.id;
          const hit = byCity.get(norm(city));
          if (hit) return hit;
          const { data: created } = await supabase
            .from("locations")
            .insert({ client_id: client.id, name: `${client.name} — ${city}`, city, state: client.state, is_physical_location: false, sort_order: 50 })
            .select("id")
            .single();
          if (created) byCity.set(norm(city), created.id);
          return created?.id ?? home!.id;
        };

        // ── Who counts as "us" in the results ─────────────────────────
        const site = client.sites?.find((s) => s.url)?.url ?? client.website_url;
        const ourHost = host(site);
        const ourNames = [client.name, client.dba].filter(Boolean).map((n) => norm(n));
        const isUs = (it: Item) => {
          const d = (it.domain ?? host(it.url) ?? "").replace(/^www\./, "").toLowerCase();
          if (ourHost && d && (d === ourHost || d.endsWith(`.${ourHost}`))) return true;
          const t = norm(it.title);
          return !!t && ourNames.some((n) => n && (t === n || t.includes(n)));
        };

        const stateFull = stateName(client.state) ?? "";
        const tasks = keywords.map((k) => ({
          keyword: k.keyword,
          location_name: `${k.city ?? client.city ?? ""},${stateFull},United States`.replace(/^,/, ""),
          language_code: "en",
          device: "desktop",
          os: "windows",
          depth: 100,
          tag: k.id,
        }));

        const rows: Record<string, unknown>[] = [];
        for (let i = 0; i < tasks.length; i += BATCH) {
          const batch = tasks.slice(i, i + BATCH);
          const res = await fetch(DFS, {
            method: "POST",
            headers: { Authorization: auth, "Content-Type": "application/json" },
            body: JSON.stringify(batch),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json) { stats.errors.push(`DataForSEO ${res.status}`); continue; }
          stats.cost += Number(json.cost ?? 0);
          for (const t of json.tasks ?? []) {
            const kwId: string | undefined = t?.data?.tag;
            const kw = keywords.find((k) => k.id === kwId);
            if (!kw) continue;
            if (t.status_code !== 20000) {
              stats.errors.push(`${kw.keyword}: ${t.status_message ?? t.status_code}`);
              continue;
            }
            const items: Item[] = t.result?.[0]?.items ?? [];
            const organic = items.filter((x) => x.type === "organic");
            const pack = items.filter((x) => x.type === "local_pack" || x.type === "map");
            const org = organic.find(isUs);
            const packHit = pack.find(isUs);
            const locationId = await locationFor(kw.city);
            rows.push({
              keyword_id: kw.id, location_id: locationId, result_type: "organic",
              position: org?.rank_group ?? null, url_ranked: org?.url ?? null,
              recorded_at: recordedAt, source: "dataforseo", run_id: runId,
            });
            rows.push({
              keyword_id: kw.id, location_id: locationId, result_type: "map_pack",
              position: packHit ? pack.indexOf(packHit) + 1 : null, url_ranked: packHit?.url ?? null,
              recorded_at: recordedAt, source: "dataforseo", run_id: runId,
            });
          }
        }

        if (rows.length) {
          const { data: inserted, error } = await supabase
            .from("rank_snapshots")
            .upsert(rows, { onConflict: "keyword_id,location_id,result_type,recorded_at,source", ignoreDuplicates: true })
            .select("id");
          if (error) stats.errors.push(`snapshots: ${error.message}`);
          else stats.snapshots = (inserted ?? []).length;
          const checked = [...new Set(rows.map((r) => r.keyword_id as string))];
          await supabase.from("keywords").update({ last_checked: recordedAt }).in("id", checked);
        }

        const { error: ciError } = await supabase.rpc("recompute_location_indexes", { p_client_id: client.id, p_period: period });
        if (ciError) stats.errors.push(`city index: ${ciError.message}`);
      } catch (e) {
        stats.errors.push(e instanceof Error ? e.message : String(e));
      }

      if (runId) {
        await supabase.from("rank_runs").update({
          status: stats.errors.length && !stats.snapshots ? "failed" : "complete",
          completed_at: new Date().toISOString(),
          checks_count: stats.snapshots,
          error: stats.errors.length ? `dataforseo · $${stats.cost.toFixed(3)} · ${stats.errors.slice(0, 12).join("; ")}` : `dataforseo · ${stats.keywords} keywords · $${stats.cost.toFixed(3)}`,
        }).eq("id", runId);
      }
      totals.clients += 1;
      totals.keywords += stats.keywords;
      totals.snapshots += stats.snapshots;
      totals.cost += stats.cost;
      totals.errors.push(...stats.errors.map((e) => `${client.name}: ${e}`));
    }
    console.log(JSON.stringify({ rank_sync: totals }));
  })();

  EdgeRuntime.waitUntil(job);
  return Response.json(
    { ok: true, started: true, clients: work.length, keywords: work.reduce((n, w) => n + w.keywords.length, 0), recorded_at: recordedAt },
    { status: 202 }
  );
});
