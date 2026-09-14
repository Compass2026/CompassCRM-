// rank-sync — weekly rank checks for every tracked keyword through
// DataForSEO's standard Google SERP task queue. Replaces BrightLocal's Local
// Rank Tracker as the source of organic + map-pack positions (BrightLocal
// stays for the 7×7 grids); the monthly BrightLocal sync is untouched.
//
// Two modes, both authorized by a team JWT or the x-cron-secret header:
//
//   post    (default; Monday 06:00 UTC cron, or by hand) — per active /
//           launching client with tracked keywords: one task per keyword at
//           the keyword's city (else the client's home city), desktop, depth
//           100, posted 100 per call to /serp/google/organic/task_post with
//           the keyword id as the tag. A rank_runs row per client stays
//           `running` until the results are in. Body { client_id } posts one
//           client.
//   collect (every 20 min cron; a no-op when nothing is ready) — asks
//           /tasks_ready, fetches each finished task, writes organic +
//           map-pack positions to rank_snapshots (source 'dataforseo',
//           recorded_at = the run's start, one row per keyword × location ×
//           result type; the natural-key index makes a re-collect a no-op),
//           stamps keywords.last_checked, completes the run once every
//           keyword has answered and recomputes the City Index. A run still
//           open after three hours is marked failed with the shortfall.
//
// Why the queue and not the live endpoint: live takes one task per request
// and costs ten times as much; the queue takes 100 per request, answers in a
// few minutes, and 400 checks a week come to about $3.50 a month.
//
// The client's site host (sites.url, else clients.website_url) gives the
// organic position; the host or the business name gives the map-pack
// position. Secrets (Vault): DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD; without
// them post answers { skipped } and nothing breaks.

import { createClient } from "npm:@supabase/supabase-js@2";

const DFS = "https://api.dataforseo.com/v3/serp/google/organic";
const BATCH = 100;
const CONCURRENCY = 10;
const RUN_TIMEOUT_MS = 3 * 60 * 60 * 1000;

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

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
  const mode: string = body.mode === "collect" ? "collect" : "post";
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
  const dfs = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${DFS}${path}`, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  };

  // ── Shared: who counts as "us", and the location row for a keyword ──────
  type ClientRow = { id: string; name: string; dba: string | null; city: string | null; state: string | null; website_url: string | null; sites: { url: string | null }[] | null };
  const identity = (client: ClientRow) => {
    const site = client.sites?.find((s) => s.url)?.url ?? client.website_url;
    const ourHost = host(site);
    const ourNames = [client.name, client.dba].filter(Boolean).map((n) => norm(n));
    return (it: Item) => {
      const d = (it.domain ?? host(it.url) ?? "").replace(/^www\./, "").toLowerCase();
      if (ourHost && d && (d === ourHost || d.endsWith(`.${ourHost}`))) return true;
      const t = norm(it.title);
      return !!t && ourNames.some((n) => n && (t === n || t.includes(n)));
    };
  };
  const locationResolver = async (client: ClientRow) => {
    const { data: locs } = await supabase
      .from("locations")
      .select("id, city, is_physical_location, sort_order")
      .eq("client_id", client.id)
      .eq("is_active", true)
      .order("is_physical_location", { ascending: false })
      .order("sort_order");
    let home = (locs ?? []).find((l) => norm(l.city) === norm(client.city)) ?? (locs ?? [])[0] ?? null;
    if (!home) {
      const { data: created } = await supabase
        .from("locations")
        .insert({ client_id: client.id, name: client.name, city: client.city, state: client.state, is_physical_location: false })
        .select("id, city, is_physical_location, sort_order")
        .single();
      home = created;
    }
    if (!home) throw new Error("no home location and could not create one");
    const byCity = new Map<string, string>();
    for (const l of locs ?? []) if (l.city) byCity.set(norm(l.city), l.id);
    return async (city: string | null): Promise<string> => {
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
  };

  // ── post ────────────────────────────────────────────────────────────────
  if (mode === "post") {
    let clientQuery = supabase
      .from("clients")
      .select("id, name, dba, city, state, website_url, sites(url)")
      .in("status", ["active", "launching"]);
    if (body.client_id) clientQuery = clientQuery.eq("id", body.client_id);
    const { data: clients, error: clientError } = await clientQuery;
    if (clientError) return Response.json({ error: clientError.message }, { status: 500 });

    const posted: { client: string; keywords: number; tasks: number; cost: number; errors: string[] }[] = [];
    for (const client of (clients ?? []) as ClientRow[]) {
      const { data: kws } = await supabase
        .from("keywords")
        .select("id, keyword, city")
        .eq("client_id", client.id)
        .eq("is_active", true)
        .eq("is_tracked", true);
      if (!kws?.length) continue;

      // One open run per client: a second post while one is running would
      // only double the bill.
      const { data: open } = await supabase
        .from("rank_runs")
        .select("id, started_at")
        .eq("client_id", client.id)
        .eq("status", "running")
        .gt("started_at", new Date(Date.now() - RUN_TIMEOUT_MS).toISOString())
        .limit(1);
      if (open?.length) { posted.push({ client: client.name, keywords: kws.length, tasks: 0, cost: 0, errors: ["a run is already open"] }); continue; }

      const stateFull = stateName(client.state) ?? "";
      const tasks = kws.map((k) => ({
        keyword: k.keyword,
        location_name: `${k.city ?? client.city ?? ""},${stateFull},United States`.replace(/^,/, ""),
        language_code: "en",
        device: "desktop",
        os: "windows",
        depth: 100,
        tag: k.id,
      }));
      const stat = { client: client.name, keywords: kws.length, tasks: 0, cost: 0, errors: [] as string[] };
      for (let i = 0; i < tasks.length; i += BATCH) {
        const { ok, status, json } = await dfs("/task_post", { method: "POST", body: JSON.stringify(tasks.slice(i, i + BATCH)) });
        if (!ok || !json) { stat.errors.push(`task_post ${status}`); continue; }
        stat.cost += Number(json.cost ?? 0);
        for (const t of json.tasks ?? []) {
          if (t.status_code === 20100) stat.tasks += 1;
          else stat.errors.push(`${t.data?.keyword ?? "?"}: ${t.status_message ?? t.status_code}`);
        }
      }
      await supabase.from("rank_runs").insert({
        client_id: client.id,
        triggered_by: triggeredBy,
        status: stat.tasks ? "running" : "failed",
        checks_count: 0,
        error: `dataforseo · posted ${stat.tasks}/${stat.keywords} · $${stat.cost.toFixed(3)}${stat.errors.length ? " · " + stat.errors.slice(0, 8).join("; ") : ""}`,
      });
      posted.push(stat);
    }
    return Response.json({ ok: true, mode, posted }, { status: 200 });
  }

  // ── collect ─────────────────────────────────────────────────────────────
  const { ok, status, json } = await dfs("/tasks_ready");
  if (!ok || !json) return Response.json({ error: `tasks_ready ${status}` }, { status: 502 });
  const ready: { id: string; tag?: string }[] = json.tasks?.[0]?.result ?? [];
  if (!ready.length) {
    // Nothing waiting; still close out runs that have gone stale.
    await supabase
      .from("rank_runs")
      .update({ status: "failed", completed_at: new Date().toISOString(), error: "dataforseo · results never arrived (3 h)" })
      .eq("status", "running")
      .lt("started_at", new Date(Date.now() - RUN_TIMEOUT_MS).toISOString())
      .like("error", "dataforseo%");
    return Response.json({ ok: true, mode, ready: 0 }, { status: 200 });
  }

  const job = (async () => {
    const tagged = ready.filter((r) => r.tag && /^[0-9a-f-]{36}$/i.test(r.tag));
    const { data: kws } = await supabase
      .from("keywords")
      .select("id, keyword, city, client_id")
      .in("id", tagged.map((r) => r.tag!));
    const kwById = new Map((kws ?? []).map((k) => [k.id, k]));
    const clientIds = [...new Set((kws ?? []).map((k) => k.client_id))];
    const { data: clients } = await supabase
      .from("clients")
      .select("id, name, dba, city, state, website_url, sites(url)")
      .in("id", clientIds);
    const { data: runs } = await supabase
      .from("rank_runs")
      .select("id, client_id, started_at")
      .in("client_id", clientIds)
      .eq("status", "running")
      .order("started_at", { ascending: false });
    const runFor = new Map<string, { id: string; started_at: string }>();
    for (const r of runs ?? []) if (!runFor.has(r.client_id)) runFor.set(r.client_id, r);
    const isUsFor = new Map<string, (it: Item) => boolean>();
    const locFor = new Map<string, (city: string | null) => Promise<string>>();
    for (const c of (clients ?? []) as ClientRow[]) {
      isUsFor.set(c.id, identity(c));
      locFor.set(c.id, await locationResolver(c));
    }

    const rows: Record<string, unknown>[] = [];
    const errors: string[] = [];
    let cost = 0;
    await pool(tagged, CONCURRENCY, async (r) => {
      const kw = kwById.get(r.tag!);
      if (!kw) return; // a task from another tool on the same account
      const got = await dfs(`/task_get/advanced/${r.id}`);
      const t = got.json?.tasks?.[0];
      if (!got.ok || !t || t.status_code !== 20000) { errors.push(`${kw.keyword}: ${t?.status_message ?? got.status}`); return; }
      cost += Number(t.cost ?? 0);
      const items: Item[] = t.result?.[0]?.items ?? [];
      const isUs = isUsFor.get(kw.client_id)!;
      const organic = items.filter((x) => x.type === "organic");
      const pack = items.filter((x) => x.type === "local_pack" || x.type === "map");
      const org = organic.find(isUs);
      const packHit = pack.find(isUs);
      const run = runFor.get(kw.client_id);
      const locationId = await locFor.get(kw.client_id)!(kw.city);
      const recordedAt = run?.started_at ?? new Date().toISOString();
      rows.push({
        keyword_id: kw.id, location_id: locationId, result_type: "organic",
        position: org?.rank_group ?? null, url_ranked: org?.url ?? null,
        recorded_at: recordedAt, source: "dataforseo", run_id: run?.id ?? null,
      });
      rows.push({
        keyword_id: kw.id, location_id: locationId, result_type: "map_pack",
        position: packHit ? pack.indexOf(packHit) + 1 : null, url_ranked: packHit?.url ?? null,
        recorded_at: recordedAt, source: "dataforseo", run_id: run?.id ?? null,
      });
    });

    let inserted = 0;
    if (rows.length) {
      const { data, error } = await supabase
        .from("rank_snapshots")
        .upsert(rows, { onConflict: "keyword_id,location_id,result_type,recorded_at,source", ignoreDuplicates: true })
        .select("id");
      if (error) errors.push(`snapshots: ${error.message}`);
      else inserted = (data ?? []).length;
      const checked = [...new Set(rows.map((r) => r.keyword_id as string))];
      await supabase.from("keywords").update({ last_checked: new Date().toISOString() }).in("id", checked);
    }

    // Close runs whose keywords have all answered; recompute the City Index.
    for (const [clientId, run] of runFor) {
      const { count: answered } = await supabase
        .from("rank_snapshots")
        .select("keyword_id", { count: "exact", head: true })
        .eq("run_id", run.id)
        .eq("result_type", "organic");
      const { count: expected } = await supabase
        .from("keywords")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("is_active", true)
        .eq("is_tracked", true);
      const stale = Date.parse(run.started_at) < Date.now() - RUN_TIMEOUT_MS;
      if ((answered ?? 0) >= (expected ?? 0) || stale) {
        await supabase.from("rank_runs").update({
          status: (answered ?? 0) >= (expected ?? 0) ? "complete" : "failed",
          completed_at: new Date().toISOString(),
          checks_count: answered ?? 0,
          error: `dataforseo · ${answered ?? 0}/${expected ?? 0} keywords${errors.length ? " · " + errors.slice(0, 6).join("; ") : ""}`,
        }).eq("id", run.id);
        await supabase.rpc("recompute_location_indexes", { p_client_id: clientId, p_period: run.started_at.slice(0, 7) + "-01" });
      } else {
        await supabase.from("rank_runs").update({ checks_count: answered ?? 0 }).eq("id", run.id);
      }
    }
    console.log(JSON.stringify({ rank_sync_collect: { ready: ready.length, inserted, cost, errors: errors.slice(0, 20) } }));
  })();

  EdgeRuntime.waitUntil(job);
  return Response.json({ ok: true, mode, ready: ready.length }, { status: 202 });
});
