import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { loadIntegrationHealth } from "./integration-health-loader.ts";
import { reportingHost } from "./integration-health.ts";
import type { GbpImport, InquiryRow, RankObservation, RankRun, ReportKeyword } from "./keyword-report.ts";
import type { GridCheck, GridConfig } from "./map-grid.ts";

// Team-only report read. Every query is scoped to this client (rank rows via
// this client's own keyword ids), reads stored records only and never calls a
// provider. Inquiry contact details are not selected.
export async function loadKeywordReport(db: SupabaseClient<Database>, clientId: string, now: string) {
  const fail = (what: string) => ({ error: `${what} could not be loaded. Please retry.` as string, data: null });
  const { data: client, error: clientError } = await db.from("clients").select("id,name,website_url,city,state").eq("id", clientId).maybeSingle();
  if (clientError) return fail("Client");
  if (!client) return { error: "not_found", data: null };
  const { data: sites } = await db.from("sites").select("url").eq("client_id", clientId);
  const siteUrl = sites?.find(s => s.url)?.url ?? client.website_url;

  const { data: kw, error: kwError } = await db.from("keywords")
    .select("id,keyword,city,intent,priority,is_money,target_url,services(name,segment)")
    .eq("client_id", clientId).eq("is_active", true).eq("is_tracked", true).order("priority").order("keyword").limit(1000);
  if (kwError) return fail("Tracked keywords");
  const keywords: ReportKeyword[] = (kw ?? []).map(k => {
    const s = (Array.isArray(k.services) ? k.services[0] : k.services) as { name: string; segment: string | null } | null;
    return { id: k.id, keyword: k.keyword, city: k.city, intent: k.intent, priority: k.priority, is_money: k.is_money, target_url: k.target_url, service: s?.name ?? null, segment: s?.segment ?? null };
  });

  const observations: RankObservation[] = [];
  for (let i = 0; i < keywords.length; i += 80) {
    for (let page = 0; ; page += 1000) {
      const { data, error } = await db.from("rank_snapshots")
        .select("id,keyword_id,location_id,result_type,position,url_ranked,recorded_at,run_id")
        .in("keyword_id", keywords.slice(i, i + 80).map(k => k.id)).eq("source", "dataforseo")
        .order("recorded_at").order("id").range(page, page + 999);
      if (error) return fail("Rank history");
      observations.push(...(data ?? []) as RankObservation[]);
      if ((data?.length ?? 0) < 1000) break;
      if (page >= 49000) return fail("Rank history (over the page limit)");
    }
  }

  const [runs, locations, gsc, ga4, gbp, inquiries, work, drafts, profiles, health] = await Promise.all([
    db.from("rank_runs").select("id,status,started_at,completed_at,checks_count,error").eq("client_id", clientId).order("started_at").limit(1000),
    db.from("locations").select("id,name,lat,lng").eq("client_id", clientId),
    db.from("gsc_performance_imports").select("property,period,period_end,created_at,data").eq("client_id", clientId).order("period").limit(500),
    db.from("ga4_performance_imports").select("property,period,period_end,created_at,data").eq("client_id", clientId).order("period").limit(500),
    db.from("gbp_performance_imports").select("location_id,period,period_end,created_at,data").eq("client_id", clientId).order("period").limit(500),
    db.from("inquiries").select("submitted_at,service_type,page_url,inquiry_sources(label)").eq("client_id", clientId).order("submitted_at").limit(5000),
    db.from("client_growth_work").select("id,kind,title,published_on,url").eq("client_id", clientId).order("published_on", { ascending: false }).limit(500),
    db.from("content_drafts").select("status").eq("client_id", clientId).limit(2000),
    db.from("map_grid_profiles").select("id,label,weekly_enabled,enabled").eq("client_id", clientId).order("created_at"),
    loadIntegrationHealth(db, [clientId], now),
  ]);
  for (const [name, r] of [["Rank runs", runs], ["Locations", locations], ["Search Console imports", gsc], ["Analytics imports", ga4], ["Business Profile imports", gbp], ["Inquiries", inquiries], ["Published work", work], ["Drafts", drafts], ["Map scans", profiles]] as const)
    if (r.error) return fail(name);

  // Maps: the latest complete scan per profile and the scan before it, with
  // their frozen config. Checks are read for those two runs only.
  const grids: { profile: { id: string; label: string; weekly_enabled: boolean; enabled: boolean }; runs: { id: string; started_at: string; completed_at: string | null; status: string; config: GridConfig; checks: Pick<GridCheck, "keyword" | "lat" | "lng" | "state" | "position">[] }[]; lastAttempt: { started_at: string; status: string; error: string | null } | null }[] = [];
  for (const profile of profiles.data ?? []) {
    const { data: pruns, error } = await db.from("map_grid_runs").select("id,started_at,completed_at,status,error,config").eq("profile_id", profile.id).order("started_at", { ascending: false }).limit(20);
    if (error) return fail("Map scans");
    const done = (pruns ?? []).filter(r => r.status === "complete").slice(0, 2);
    const withChecks = [];
    for (const r of done) {
      const { data: checks, error: checkError } = await db.from("map_grid_checks").select("keyword,lat,lng,state,position").eq("run_id", r.id).limit(2000);
      if (checkError) return fail("Map scan results");
      withChecks.push({ id: r.id, started_at: r.started_at, completed_at: r.completed_at, status: r.status, config: r.config as unknown as GridConfig, checks: checks ?? [] });
    }
    const last = pruns?.[0];
    grids.push({ profile, runs: withChecks, lastAttempt: last ? { started_at: last.started_at, status: last.status, error: last.error } : null });
  }

  return {
    error: null,
    data: {
      client, siteUrl, siteHost: reportingHost(siteUrl), keywords, observations,
      runs: (runs.data ?? []) as RankRun[], locations: locations.data ?? [],
      gsc: gsc.data ?? [], ga4: ga4.data ?? [], gbp: (gbp.data ?? []) as GbpImport[],
      inquiries: (inquiries.data ?? []).map(i => ({ submitted_at: i.submitted_at, service_type: i.service_type, page_url: i.page_url, source: (Array.isArray(i.inquiry_sources) ? i.inquiry_sources[0] : i.inquiry_sources)?.label ?? null })) as InquiryRow[],
      work: work.data ?? [], draftsInReview: (drafts.data ?? []).filter(d => d.status === "in_review").length,
      grids, health,
    },
  };
}
