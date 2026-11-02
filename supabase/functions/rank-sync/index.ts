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
// Each keyword is measured against its own website (_shared/rank-site.ts):
// the client's one site, or for a multi-brand client the brand site that
// owns the keyword's service. That host gives the organic position and is
// stored on the snapshot (site_host); the host or the business / brand name
// gives the map-pack position. A keyword whose site cannot be resolved is
// not posted (no paid check that could not be attributed) and is named in
// the run's error. Secrets (Vault): DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD; without
// them post answers { skipped } and nothing breaks.

import { createClient } from "npm:@supabase/supabase-js@2";
import { keywordSite, onKeywordSite, type RankSiteClient } from "../_shared/rank-site.ts";

import { localRankBlock } from "./market.ts";

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
    // Signed in is not enough once clients have portal logins: team only.
    const { data: member } = await supabase.from("team_members").select("id").eq("auth_user_id", userData.user.id).maybeSingle();
    if (!member) return Response.json({ error: "forbidden" }, { status: 403 });
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
  type ClientRow = RankSiteClient & { id: string; city: string | null; state: string | null; business_type: string | null };
  const CLIENT_COLUMNS = "id, name, dba, city, state, business_type, website_url, sites(id, url), client_brand_workspaces(id, name, website_url, blog_site_id, service_ids)";
  const identity = (ourHost: string, names: string[]) => {
    const ourNames = names.map((n) => norm(n));
    const onSite = (it: Item) => onKeywordSite(it.domain ?? it.url, ourHost);
    // Organic is the website only. A directory, social or review page titled
    // with the business name (or another firm with the same name) is not the
    // site's rank (Lucas, Oct 2026: Facebook, MapQuest, Angi in Washington).
    // The map pack lists the business itself, so its name counts there.
    return {
      organic: onSite,
      pack: (it: Item) => {
        if (onSite(it)) return true;
        const t = norm(it.title);
        return !!t && ourNames.some((n) => n && (t === n || t.includes(n)));
      },
    };
  };
  // Locations: the home row plus any row whose city matches a keyword's
  // city. Rows with coordinates are checked by coordinate (DataForSEO knows
  // every lat/lng; it does not know every small town by name). A keyword
  // city with no row is checked by name, and re-checked at the home
  // coordinates when the name is refused. rank-sync never creates rows;
  // Tracking Setup and the worker own those.
  type Loc = { id: string; city: string | null; lat: number | null; lng: number | null };
  const coordKey = (l: { lat: number | null; lng: number | null }) => (l.lat != null && l.lng != null ? `${l.lat},${l.lng}` : null);
  const locationResolver = async (client: ClientRow) => {
    const { data: locs } = await supabase
      .from("locations")
      .select("id, city, lat, lng, is_physical_location, sort_order")
      .eq("client_id", client.id)
      .eq("is_active", true)
      .order("is_physical_location", { ascending: false })
      .order("sort_order");
    let home: Loc | null = (locs ?? []).find((l) => norm(l.city) === norm(client.city)) ?? (locs ?? [])[0] ?? null;
    if (!home) {
      const { data: created } = await supabase
        .from("locations")
        .insert({ client_id: client.id, name: client.name, city: client.city, state: client.state, is_physical_location: false })
        .select("id, city, lat, lng")
        .single();
      home = created;
    }
    if (!home) throw new Error("no home location and could not create one");
    const byCity = new Map<string, Loc>();
    const byCoord = new Map<string, Loc>();
    for (const l of (locs ?? []) as Loc[]) {
      if (l.city) byCity.set(norm(l.city), l);
      const k = coordKey(l);
      if (k) byCoord.set(k, l);
    }
    return {
      home,
      forCity: (city: string | null): Loc | null => (!city || norm(city) === norm(client.city) ? home : byCity.get(norm(city)) ?? null),
      byCoord,
    };
  };

  // ── post ────────────────────────────────────────────────────────────────────
  if (mode === "post") {
    let clientQuery = supabase
      .from("clients")
      .select(CLIENT_COLUMNS)
      .in("status", ["active", "launching"]);
    if (body.client_id) clientQuery = clientQuery.eq("id", body.client_id);
    const { data: clients, error: clientError } = await clientQuery;
    if (clientError) return Response.json({ error: clientError.message }, { status: 500 });

    const posted: { client: string; keywords: number; tasks: number; cost: number; errors: string[] }[] = [];
    for (const client of (clients ?? []) as ClientRow[]) {
      const { data: tracked } = await supabase
        .from("keywords")
        .select("id, keyword, city, service_id")
        .eq("client_id", client.id)
        .eq("is_active", true)
        .eq("is_tracked", true);
      if (!tracked?.length) continue;
      const marketBlock = localRankBlock(client.business_type);
      if (marketBlock) {
        posted.push({ client: client.name, keywords: tracked.length, tasks: 0, cost: 0, errors: [marketBlock] });
        continue;
      }
      // Only keywords whose own website is known are checked.
      const unsited: string[] = [];
      const kws = tracked.filter((k) => {
        const site = keywordSite(client, k);
        if (!site.ok) unsited.push(`${k.keyword}: not checked, ${site.problem}`);
        return site.ok;
      });

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
      const locs = await locationResolver(client);
      const homeCoord = coordKey(locs.home);
      const taskFor = (k: { id: string; keyword: string; city: string | null }, atHome = false) => {
        const loc = atHome ? locs.home : locs.forCity(k.city);
        const coord = loc ? coordKey(loc) : null;
        const base = { keyword: k.keyword, language_code: "en", device: "desktop", os: "windows", depth: 100, tag: k.id };
        if (coord) return { ...base, location_coordinate: coord };
        return { ...base, location_name: `${k.city ?? client.city ?? ""},${stateFull},United States`.replace(/^,/, "") };
      };
      const stat = { client: client.name, keywords: tracked.length, tasks: 0, cost: 0, retried: 0, errors: [...unsited] as string[] };
      const postBatch = async (batch: Record<string, unknown>[]): Promise<string[]> => {
        const refused: string[] = [];
        for (let i = 0; i < batch.length; i += BATCH) {
          const { ok, status, json } = await dfs("/task_post", { method: "POST", body: JSON.stringify(batch.slice(i, i + BATCH)) });
          if (!ok || !json) { stat.errors.push(`task_post ${status}`); continue; }
          stat.cost += Number(json.cost ?? 0);
          for (const t of json.tasks ?? []) {
            if (t.status_code === 20100) stat.tasks += 1;
            else if (/location/i.test(t.status_message ?? "") && t.data?.tag) refused.push(String(t.data.tag));
            else stat.errors.push(`${t.data?.keyword ?? "?"}: ${t.status_message ?? t.status_code}`);
          }
        }
        return refused;
      };
      const refused = kws.length ? await postBatch(kws.map((k) => taskFor(k))) : [];
      if (refused.length && homeCoord) {
        // The city name was not in DataForSEO's list; check those at the home coordinates.
        stat.retried = refused.length;
        const again = await postBatch(kws.filter((k) => refused.includes(k.id)).map((k) => taskFor(k, true)));
        for (const id of again) stat.errors.push(`${kws.find((k) => k.id === id)?.keyword ?? id}: location refused twice`);
      } else if (refused.length) {
        for (const id of refused) stat.errors.push(`${kws.find((k) => k.id === id)?.keyword ?? id}: location refused and no home coordinates`);
      }
      await supabase.from("rank_runs").insert({
        client_id: client.id,
        triggered_by: triggeredBy,
        status: stat.tasks ? "running" : "failed",
        checks_count: stat.tasks,
        error: `dataforseo · posted ${stat.tasks}/${stat.keywords}${stat.retried ? ` (${stat.retried} at home coordinates)` : ""} · $${stat.cost.toFixed(3)}${stat.errors.length ? " · " + stat.errors.slice(0, 8).join("; ") : ""}`,
      });
      posted.push(stat);
    }
    return Response.json({ ok: true, mode, posted }, { status: 200 });
  }

  // ── collect ─────────────────────────────────────────────────────────────────
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
    // Bound PostgREST URLs as the client roster grows. Never ignore read errors.
    const kws: {id:string;keyword:string;city:string|null;client_id:string;service_id:string|null}[]=[];
    for(let offset=0;offset<tagged.length;offset+=80) {
      let query=supabase.from("keywords").select("id, keyword, city, client_id, service_id")
        .in("id",tagged.slice(offset,offset+80).map(r=>r.tag!));
      if(body.client_id)query=query.eq("client_id",body.client_id);
      const {data,error}=await query;
      if(error)throw new Error(`keyword_lookup_failed: ${error.code}`);
      kws.push(...(data??[]));
    }
    const kwById = new Map((kws ?? []).map((k) => [k.id, k]));
    const clientIds = [...new Set((kws ?? []).map((k) => k.client_id))];
    const { data: clients, error: clientsError } = await supabase
      .from("clients")
      .select(CLIENT_COLUMNS)
      .in("id", clientIds);
    if(clientsError)throw new Error(`client_lookup_failed: ${clientsError.code}`);
    const { data: runs, error: runsError } = await supabase
      .from("rank_runs")
      .select("id, client_id, started_at, checks_count")
      .in("client_id", clientIds)
      .eq("status", "running")
      .order("started_at", { ascending: false });
    if(runsError)throw new Error(`run_lookup_failed: ${runsError.code}`);
    const runFor = new Map<string, { id: string; started_at: string; checks_count: number | null }>();
    for (const r of runs ?? []) if (!runFor.has(r.client_id)) runFor.set(r.client_id, r);
    const clientFor = new Map<string, ClientRow>();
    const locFor = new Map<string, Awaited<ReturnType<typeof locationResolver>>>();
    for (const c of (clients ?? []) as ClientRow[]) {
      clientFor.set(c.id, c);
      if (!localRankBlock(c.business_type)) locFor.set(c.id, await locationResolver(c));
    }

    const rows: Record<string, unknown>[] = [];
    const errors: string[] = [];
    let cost = 0;
    await pool(tagged, CONCURRENCY, async (r) => {
      const kw = kwById.get(r.tag!);
      if (!kw) return; // a task from another tool on the same account
      const marketBlock = localRankBlock(clientFor.get(kw.client_id)?.business_type);
      if (marketBlock) { errors.push(`${kw.keyword}: ${marketBlock}`); return; }
      const got = await dfs(`/task_get/advanced/${r.id}`);
      const t = got.json?.tasks?.[0];
      if (!got.ok || !t || t.status_code !== 20000) { errors.push(`${kw.keyword}: ${t?.status_message ?? got.status}`); return; }
      cost += Number(t.cost ?? 0);
      const items: Item[] = t.result?.[0]?.items ?? [];
      // Judged against this keyword's own site, resolved now: a sister
      // brand's result is never this keyword's rank.
      const site = keywordSite(clientFor.get(kw.client_id)!, kw);
      if (!site.ok) { errors.push(`${kw.keyword}: not recorded, ${site.problem}`); return; }
      const isUs = identity(site.host, site.names);
      const organic = items.filter((x) => x.type === "organic");
      const pack = items.filter((x) => x.type === "local_pack" || x.type === "map");
      const org = organic.find(isUs.organic);
      const packHit = pack.find(isUs.pack);
      const run = runFor.get(kw.client_id);
      const locs = locFor.get(kw.client_id)!;
      const coord: string | undefined = t.data?.location_coordinate;
      const locationId = (coord && locs.byCoord.get(coord)?.id) ?? locs.forCity(kw.city)?.id ?? locs.home.id;
      const recordedAt = run?.started_at ?? new Date().toISOString();
      rows.push({
        keyword_id: kw.id, location_id: locationId, result_type: "organic",
        position: org?.rank_group ?? null, url_ranked: org?.url ?? null,
        recorded_at: recordedAt, source: "dataforseo", run_id: run?.id ?? null, site_host: site.host,
      });
      rows.push({
        keyword_id: kw.id, location_id: locationId, result_type: "map_pack",
        position: packHit ? pack.indexOf(packHit) + 1 : null, url_ranked: packHit?.url ?? null,
        recorded_at: recordedAt, source: "dataforseo", run_id: run?.id ?? null, site_host: site.host,
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
      if(!error)for(let offset=0;offset<checked.length;offset+=80) {
        const marked=await supabase.from("keywords").update({last_checked:new Date().toISOString()}).in("id",checked.slice(offset,offset+80));
        if(marked.error)errors.push(`keyword timestamp: ${marked.error.code}`);
      }
    }

    // Close runs whose keywords have all answered; recompute the City Index.
    for (const [clientId, run] of runFor) {
      const { count: answered } = await supabase
        .from("rank_snapshots")
        .select("keyword_id", { count: "exact", head: true })
        .eq("run_id", run.id)
        .eq("result_type", "organic");
      // What was posted for this run is what we wait for (a refused city
      // name never becomes a task); tracked count is the fallback.
      let expected = run.checks_count ?? 0;
      if (!expected) {
        const { count } = await supabase
          .from("keywords")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .eq("is_active", true)
          .eq("is_tracked", true);
        expected = count ?? 0;
      }
      const stale = Date.parse(run.started_at) < Date.now() - RUN_TIMEOUT_MS;
      if ((answered ?? 0) >= expected || stale) {
        await supabase.from("rank_runs").update({
          status: (answered ?? 0) >= expected ? "complete" : "failed",
          completed_at: new Date().toISOString(),
          checks_count: answered ?? 0,
          error: `dataforseo · ${answered ?? 0}/${expected} answered${errors.length ? " · " + errors.slice(0, 6).join("; ") : ""}`,
        }).eq("id", run.id);
        await supabase.rpc("recompute_location_indexes", { p_client_id: clientId, p_period: run.started_at.slice(0, 7) + "-01" });
      }
    }
    const result={ready:ready.length,matched:kws.length,inserted,cost,errors:errors.slice(0,20)};
    console.log(JSON.stringify({rank_sync_collect:result}));
    return result;
  })();

  if(body.wait===true) {
    try{return Response.json({ok:true,mode,...await job});}
    catch(e){return Response.json({error:e instanceof Error?e.message:"collection_failed"},{status:503});}
  }
  EdgeRuntime.waitUntil(job);
  return Response.json({ ok: true, mode, ready: ready.length }, { status: 202 });
});
