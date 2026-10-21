import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { loadIntegrationHealth } from "./integration-health-loader.ts";
import { resolveScope, type GbpImport, type InquiryRow, type RankObservation, type RankRun, type ReportKeyword } from "./keyword-report.ts";
import type { GridCheck, GridConfig } from "./map-grid.ts";

type DbError = { code?: string; message: string } | null;
type Page<T> = PromiseLike<{ data: T[] | null; error: DbError; count: number | null }>;
const PAGE = 1000;

// Complete read or nothing: the exact count comes back with the first page
// and every page is fetched until the rows match it. A server row cap, a
// changed table or a count above `max` is an error, never a silent truncation.
export async function readAll<T>(page: (from: number, to: number) => Page<T>, max = 50000): Promise<{ rows: T[]; error: null } | { rows: null; error: { code: string; message: string } }> {
  const rows: T[] = [];
  let total: number | null = null;
  for (let from = 0; total === null || rows.length < total; from += PAGE) {
    const { data, error, count } = await page(from, from + PAGE - 1);
    if (error) return { rows: null, error: { code: error.code ?? "unknown", message: error.message } };
    if (total === null) {
      if (count === null) return { rows: null, error: { code: "count_unavailable", message: "row count not returned" } };
      if (count > max) return { rows: null, error: { code: "over_limit", message: `${count} rows exceed the report limit of ${max}` } };
      total = count;
    }
    rows.push(...(data ?? []));
    if (!data?.length && rows.length < total) return { rows: null, error: { code: "incomplete_read", message: `${rows.length} of ${total} rows returned` } };
  }
  if (rows.length !== total) return { rows: null, error: { code: "incomplete_read", message: `${rows.length} of ${total} rows returned` } };
  return { rows, error: null };
}

// Team-only report read. Every query is scoped to this client (rank rows via
// this client's own keyword ids), reads stored records only and never calls a
// provider. Inquiry contact details are not selected. Failures are logged
// server-side with the PostgREST code and shown with the code only.
export async function loadKeywordReport(db: SupabaseClient<Database>, clientId: string, now: string) {
  const fail = (what: string, error: DbError) => {
    console.error(JSON.stringify({ keyword_report_read_failed: { what, client_id: clientId, code: error?.code ?? "unknown", message: error?.message ?? "" } }));
    return { error: `${what} could not be loaded (${error?.code ?? "unknown"}). Please retry.` as string, data: null };
  };
  const { data: client, error: clientError } = await db.from("clients").select("id,name,website_url,city,state,gsc_property,ga4_property").eq("id", clientId).maybeSingle();
  if (clientError) return fail("Client", clientError);
  if (!client) return { error: "not_found", data: null };

  const c = { count: "exact" as const };
  const [sites, brands, gbpBindings] = await Promise.all([
    readAll<{ url: string | null }>((f, t) => db.from("sites").select("url", c).eq("client_id", clientId).order("created_at").order("id").range(f, t)),
    readAll<{ id: string }>((f, t) => db.from("client_brand_workspaces").select("id", c).eq("client_id", clientId).order("id").range(f, t)),
    readAll<{ publish_account_id: string | null; publish_page_id: string | null; external_account_id: string | null }>((f, t) => db.from("social_accounts").select("publish_account_id,publish_page_id,external_account_id", c).eq("client_id", clientId).eq("platform", "google_business").eq("publish_provider", "zernio").order("id").range(f, t)),
  ]);
  for (const [name, r] of [["Website records", sites], ["Brand workspaces", brands], ["Business Profile connection", gbpBindings]] as const) if (r.error) return fail(name, r.error);
  const scope = resolveScope({ websiteUrl: client.website_url, gscProperty: client.gsc_property, ga4Property: client.ga4_property, siteUrls: sites.rows!.map(s => s.url), brandCount: brands.rows!.length, gbpBindings: gbpBindings.rows! });

  // keywords has two relationships to services (service_id, and
  // services.primary_keyword_id); the embed must name the one it means.
  const kw = await readAll<{ id: string; keyword: string; city: string | null; intent: string | null; priority: string | null; is_money: boolean | null; target_url: string | null; services: unknown }>((f, t) => db.from("keywords")
    .select("id,keyword,city,intent,priority,is_money,target_url,services!keywords_service_id_fkey(name,segment)", c)
    .eq("client_id", clientId).eq("is_active", true).eq("is_tracked", true).order("priority").order("keyword").order("id").range(f, t), 2000);
  if (kw.error) return fail("Tracked keywords", kw.error);
  const keywords: ReportKeyword[] = kw.rows.map(k => {
    const s = (Array.isArray(k.services) ? k.services[0] : k.services) as { name: string; segment: string | null } | null;
    return { id: k.id, keyword: k.keyword, city: k.city, intent: k.intent, priority: k.priority, is_money: k.is_money, target_url: k.target_url, service: s?.name ?? null, segment: s?.segment ?? null };
  });

  const observations: RankObservation[] = [];
  for (let i = 0; i < keywords.length; i += 80) {
    const chunk = keywords.slice(i, i + 80).map(k => k.id);
    const r = await readAll<RankObservation>((f, t) => db.from("rank_snapshots")
      .select("keyword_id,location_id,result_type,position,url_ranked,recorded_at,run_id", c)
      .in("keyword_id", chunk).eq("source", "dataforseo").order("recorded_at").order("id").range(f, t));
    if (r.error) return fail("Rank history", r.error);
    observations.push(...r.rows);
  }

  const [runs, locations, gsc, ga4, gbp, inquiries, work, drafts, profiles, health] = await Promise.all([
    readAll<RankRun>((f, t) => db.from("rank_runs").select("id,status,started_at,completed_at,checks_count,error,triggered_by", c).eq("client_id", clientId).order("started_at").order("id").range(f, t)),
    readAll<{ id: string; name: string; lat: number | null; lng: number | null }>((f, t) => db.from("locations").select("id,name,lat,lng", c).eq("client_id", clientId).order("id").range(f, t)),
    readAll<{ property: string; period: string; period_end: string; created_at: string; data: unknown }>((f, t) => db.from("gsc_performance_imports").select("property,period,period_end,created_at,data", c).eq("client_id", clientId).order("period").order("id").range(f, t)),
    readAll<{ property: string; period: string; period_end: string; created_at: string; data: unknown }>((f, t) => db.from("ga4_performance_imports").select("property,period,period_end,created_at,data", c).eq("client_id", clientId).order("period").order("id").range(f, t)),
    readAll<GbpImport>((f, t) => db.from("gbp_performance_imports").select("account_id,location_id,period,period_end,created_at,data", c).eq("client_id", clientId).order("period").order("id").range(f, t)),
    readAll<{ submitted_at: string; service_type: string | null; page_url: string | null; inquiry_sources: unknown }>((f, t) => db.from("inquiries").select("submitted_at,service_type,page_url,inquiry_sources!inquiries_source_id_client_id_fkey(label)", c).eq("client_id", clientId).order("submitted_at").order("id").range(f, t)),
    readAll<{ id: string; kind: string; title: string; published_on: string; url: string | null }>((f, t) => db.from("client_growth_work").select("id,kind,title,published_on,url", c).eq("client_id", clientId).order("published_on", { ascending: false }).order("id").range(f, t)),
    readAll<{ status: string }>((f, t) => db.from("content_drafts").select("status", c).eq("client_id", clientId).order("id").range(f, t)),
    readAll<{ id: string; label: string; weekly_enabled: boolean; enabled: boolean; target_place_id: string }>((f, t) => db.from("map_grid_profiles").select("id,label,weekly_enabled,enabled,target_place_id", c).eq("client_id", clientId).order("created_at").order("id").range(f, t)),
    loadIntegrationHealth(db, [clientId], now),
  ]);
  for (const [name, r] of [["Rank runs", runs], ["Locations", locations], ["Search Console imports", gsc], ["Analytics imports", ga4], ["Business Profile imports", gbp], ["Inquiries", inquiries], ["Published work", work], ["Drafts", drafts], ["Map scans", profiles]] as const)
    if (r.error) return fail(name, r.error);

  // Maps: every run of each profile (for health), plus the checks of the two
  // latest complete runs (for the table and a like-for-like comparison).
  type ScanRun = { id: string; profile_id: string; started_at: string; completed_at: string | null; status: string; error: string | null; expected_checks: number | null; config: GridConfig };
  const grids: { profile: { id: string; label: string; weekly_enabled: boolean; enabled: boolean; target_place_id: string }; attempts: ScanRun[]; runs: (ScanRun & { checks: Pick<GridCheck, "keyword" | "lat" | "lng" | "state" | "position">[] })[] }[] = [];
  for (const profile of profiles.rows!) {
    const pruns = await readAll<Omit<ScanRun, "config"> & { config: unknown }>((f, t) => db.from("map_grid_runs").select("id,profile_id,started_at,completed_at,status,error,expected_checks,config", c).eq("profile_id", profile.id).order("started_at", { ascending: false }).order("id").range(f, t));
    if (pruns.error) return fail("Map scans", pruns.error);
    const scans = pruns.rows.map(r => ({ ...r, config: r.config as GridConfig }));
    const withChecks = [];
    for (const r of scans.filter(r => r.status === "complete").slice(0, 2)) {
      const checks = await readAll<Pick<GridCheck, "keyword" | "lat" | "lng" | "state" | "position">>((f, t) => db.from("map_grid_checks").select("keyword,lat,lng,state,position", c).eq("run_id", r.id).order("id").range(f, t));
      if (checks.error) return fail("Map scan results", checks.error);
      withChecks.push({ ...r, checks: checks.rows });
    }
    grids.push({ profile, attempts: scans, runs: withChecks });
  }

  return {
    error: null,
    data: {
      client, scope, keywords, observations,
      runs: runs.rows!, locations: locations.rows!,
      gsc: gsc.rows!, ga4: ga4.rows!, gbp: gbp.rows!,
      inquiries: inquiries.rows!.map(i => ({ submitted_at: i.submitted_at, service_type: i.service_type, page_url: i.page_url, source: ((Array.isArray(i.inquiry_sources) ? i.inquiry_sources[0] : i.inquiry_sources) as { label: string } | null)?.label ?? null })) as InquiryRow[],
      work: work.rows!, draftsInReview: drafts.rows!.filter(d => d.status === "in_review").length,
      grids, health,
    },
  };
}
