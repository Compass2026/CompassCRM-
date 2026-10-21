import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { readAll } from "./keyword-report-data.ts";
import { resolveScope, type RankObservation, type RankRun, type ReportKeyword } from "./keyword-report.ts";
import { localDate, monthOfPeriod, reportCutoff, type GridInput, type MonthlyReportInput, type ScanRunInput } from "./monthly-report.ts";

type DbError = { code?: string; message: string } | null;
type SocialRow = { id: string; client_id: string; platform: string; copy: string | null; published_url: string | null; published_at: string | null; service_id: string | null; review_status: string; publish_status: string; created_at: string };
const fail = (clientId: string, what: string, error: DbError) => {
  console.error(JSON.stringify({ monthly_report_read_failed: { what, client_id: clientId, code: error?.code ?? "unknown", message: error?.message ?? "" } }));
  return { error: `${what} could not be loaded (${error?.code ?? "unknown"}). Please retry.`, data: null } as const;
};

// Everything one month's report needs, read for exactly this client from
// stored records. No provider is called and no contact detail is selected.
// Multi-brand clients are refused until the per-brand split is built.
export async function loadMonthlyReportInput(db: SupabaseClient<Database>, clientId: string, period: string, now: string): Promise<{ error: string; data: null } | { error: null; data: MonthlyReportInput }> {
  const month = monthOfPeriod(period);
  const cutoff = reportCutoff(month.period, now);
  const { data: client, error: clientError } = await db.from("clients").select("id,name,website_url,gsc_property,ga4_property").eq("id", clientId).maybeSingle();
  if (clientError) return fail(clientId, "Client", clientError);
  if (!client) return { error: "not_found", data: null };

  const c = { count: "exact" as const };
  const [sites, brands, gbpBindings, services, colors, brand] = await Promise.all([
    readAll<{ url: string | null }>((f, t) => db.from("sites").select("url", c).eq("client_id", clientId).order("created_at").order("id").range(f, t)),
    readAll<{ id: string }>((f, t) => db.from("client_brand_workspaces").select("id", c).eq("client_id", clientId).order("id").range(f, t)),
    readAll<{ publish_account_id: string | null; publish_page_id: string | null; external_account_id: string | null }>((f, t) => db.from("social_accounts").select("publish_account_id,publish_page_id,external_account_id", c).eq("client_id", clientId).eq("platform", "google_business").eq("publish_provider", "zernio").order("id").range(f, t)),
    readAll<{ id: string; name: string; segment: string | null }>((f, t) => db.from("services").select("id,name,segment", c).eq("client_id", clientId).order("id").range(f, t)),
    readAll<{ hex: string; role: string | null }>((f, t) => db.from("brand_colors").select("hex,role", c).eq("client_id", clientId).order("sort_order").order("id").range(f, t)),
    db.from("client_brands").select("tagline").eq("client_id", clientId).maybeSingle(),
  ]);
  for (const [name, r] of [["Website records", sites], ["Brand workspaces", brands], ["Business Profile connection", gbpBindings], ["Services", services], ["Brand colors", colors]] as const)
    if (r.error) return fail(clientId, name, r.error);
  if (brand.error) return fail(clientId, "Brand", brand.error);
  if (brands.rows!.length) return { error: `This client reports per brand website (${brands.rows!.length}). Monthly reports for brand websites are not built yet; nothing was generated.`, data: null };
  const scope = resolveScope({ websiteUrl: client.website_url, gscProperty: client.gsc_property, ga4Property: client.ga4_property, siteUrls: sites.rows!.map(s => s.url), brandCount: 0, gbpBindings: gbpBindings.rows! });
  const service = new Map(services.rows!.map(s => [s.id, s]));

  const kw = await readAll<{ id: string; keyword: string; city: string | null; intent: string | null; priority: string | null; is_money: boolean | null; target_url: string | null; service_id: string | null }>((f, t) => db.from("keywords")
    .select("id,keyword,city,intent,priority,is_money,target_url,service_id", c)
    .eq("client_id", clientId).eq("is_active", true).eq("is_tracked", true).order("priority").order("keyword").order("id").range(f, t), 2000);
  if (kw.error) return fail(clientId, "Tracked keywords", kw.error);
  const keywords: ReportKeyword[] = kw.rows.map(k => ({ ...k, service: service.get(k.service_id ?? "")?.name ?? null, segment: service.get(k.service_id ?? "")?.segment ?? null }));
  const observations: RankObservation[] = [];
  for (let i = 0; i < keywords.length; i += 80) {
    const chunk = keywords.slice(i, i + 80).map(k => k.id);
    const r = await readAll<RankObservation>((f, t) => db.from("rank_snapshots")
      .select("keyword_id,location_id,result_type,position,url_ranked,recorded_at,run_id", c)
      .in("keyword_id", chunk).eq("source", "dataforseo").lte("recorded_at", cutoff).order("recorded_at").order("id").range(f, t));
    if (r.error) return fail(clientId, "Rank history", r.error);
    observations.push(...r.rows);
  }

  const prev = monthOfPeriod(month.previous);
  const [runs, measurements, inquiries, inquirySources, blogs, social, queue, rewrites, reverts, drafts, profiles, targets] = await Promise.all([
    readAll<RankRun>((f, t) => db.from("rank_runs").select("id,status,started_at,completed_at,checks_count,error,triggered_by", c).eq("client_id", clientId).lte("started_at", cutoff).order("started_at").order("id").range(f, t)),
    readAll<MonthlyReportInput["measurements"][number]>((f, t) => db.from("report_measurements")
      .select("client_id,metric,scope,source,status,value,report_period,window_start,window_end,sequence,created_at", c)
      .eq("client_id", clientId).in("report_period", [month.period, month.previous]).order("sequence").range(f, t)),
    readAll<{ client_id: string; submitted_at: string; service_type: string | null; page_url: string | null; inquiry_sources: unknown }>((f, t) => db.from("inquiries")
      .select("client_id,submitted_at,service_type,page_url,inquiry_sources!inquiries_source_id_client_id_fkey(label)", c)
      .eq("client_id", clientId).gte("submitted_at", prev.start).lte("submitted_at", cutoff).order("submitted_at").order("id").range(f, t)),
    readAll<{ id: string; enabled: boolean }>((f, t) => db.from("inquiry_sources").select("id,enabled", c).eq("client_id", clientId).order("id").range(f, t)),
    readAll<{ id: string; client_id: string; title: string; url: string | null; published_at: string | null; keyword_id: string | null }>((f, t) => db.from("content_posts")
      .select("id,client_id,title,url,published_at,keyword_id", c).eq("client_id", clientId).eq("origin", "compass").eq("status", "published")
      .gte("published_at", month.period).lte("published_at", localDate(cutoff)).order("published_at").order("id").range(f, t)),
    readAll<SocialRow>((f, t) => db.from("social_posts")
      .select("id,client_id,platform,copy,published_url,published_at,service_id,review_status,publish_status,created_at", c).eq("client_id", clientId).in("platform", ["facebook", "google_business"])
      .eq("publish_status", "published").gte("published_at", month.start).lte("published_at", cutoff).order("published_at").order("id").range(f, t)),
    // The queue as it stands now: in review, approved but not out, failed.
    readAll<SocialRow>((f, t) => db.from("social_posts")
      .select("id,client_id,platform,copy,published_url,published_at,service_id,review_status,publish_status,created_at", c).eq("client_id", clientId).in("platform", ["facebook", "google_business"])
      .neq("publish_status", "published").order("created_at").order("id").range(f, t), 5000),
    readAll<{ id: string; client_id: string; created_at: string; after: unknown }>((f, t) => db.from("change_log")
      .select("id,client_id,created_at,after", c).eq("client_id", clientId).eq("change_type", "page_rewrite").eq("object_type", "site").eq("status", "approved").order("created_at").order("id").range(f, t)),
    readAll<{ after: unknown }>((f, t) => db.from("change_log").select("after", c).eq("client_id", clientId).eq("change_type", "revert").order("id").range(f, t)),
    readAll<{ deliverable: string; status: string }>((f, t) => db.from("content_drafts").select("deliverable,status", c).eq("client_id", clientId).eq("status", "in_review").order("id").range(f, t)),
    readAll<{ id: string; label: string; weekly_enabled: boolean; enabled: boolean }>((f, t) => db.from("map_grid_profiles").select("id,label,weekly_enabled,enabled", c).eq("client_id", clientId).order("created_at").order("id").range(f, t)),
    db.rpc("delivery_targets", { p_client_id: clientId, p_month: month.period }),
  ]);
  for (const [name, r] of [["Rank runs", runs], ["Measurements", measurements], ["Inquiries", inquiries], ["Inquiry sources", inquirySources], ["Blog posts", blogs], ["Social posts", social], ["Social queue", queue], ["Page rewrites", rewrites], ["Reverts", reverts], ["Drafts", drafts], ["Map scans", profiles]] as const)
    if (r.error) return fail(clientId, name, r.error);
  if (targets.error) return fail(clientId, "Delivery targets", targets.error);

  // Query sample: the newest stored window that ended by the cutoff.
  const { data: lastWindow, error: windowError } = await db.from("gsc_snapshots").select("period_end").eq("client_id", clientId).lte("period_end", localDate(cutoff)).order("period_end", { ascending: false }).limit(1).maybeSingle();
  if (windowError) return fail(clientId, "Search Console query sample", windowError);
  const sample = lastWindow ? await readAll<MonthlyReportInput["querySample"][number]>((f, t) => db.from("gsc_snapshots")
    .select("client_id,query,clicks,impressions,period_start,period_end", c).eq("client_id", clientId).eq("period_end", lastWindow.period_end).order("id").range(f, t), 20000) : { rows: [], error: null };
  if (sample.error) return fail(clientId, "Search Console query sample", sample.error);

  // Maps: the latest complete scan started in the month (by the cutoff) and
  // the complete scan before it, with their checks.
  const grids: GridInput[] = [];
  for (const profile of profiles.rows!) {
    const raw = await readAll<Omit<ScanRunInput, "config"> & { config: unknown }>((f, t) => db.from("map_grid_runs").select("id,profile_id,started_at,completed_at,status,config", c).eq("profile_id", profile.id).lte("started_at", cutoff).order("started_at").order("id").range(f, t));
    if (raw.error) return fail(clientId, "Map scans", raw.error);
    const pruns = { rows: raw.rows.map(r => ({ ...r, config: (r.config ?? {}) as ScanRunInput["config"] })) };
    const inMonth = pruns.rows.filter(r => r.started_at >= month.start);
    const complete = pruns.rows.filter(r => r.status === "complete");
    const current = complete.filter(r => r.started_at >= month.start).at(-1) ?? null;
    const previous = current ? complete.filter(r => r.started_at < current.started_at).at(-1) ?? null : null;
    const withChecks = async (r: ScanRunInput | null) => {
      if (!r) return null;
      const checks = await readAll<{ state: string; position: number | null }>((f, t) => db.from("map_grid_checks").select("state,position", c).eq("run_id", r.id).order("id").range(f, t));
      if (checks.error) throw Object.assign(new Error(checks.error.message), { code: checks.error.code });
      return { ...r, checks: checks.rows };
    };
    try {
      grids.push({ profile, attempts: inMonth.map(({ id, started_at, completed_at, status }) => ({ id, started_at, completed_at, status })), current: await withChecks(current), previous: await withChecks(previous) });
    } catch (e) { return fail(clientId, "Map scan results", { code: (e as { code?: string }).code, message: (e as Error).message }); }
  }

  // Page refreshes: counted only on a live receipt not undone by a revert
  // (the rule delivery_targets() applies).
  const reverted = reverts.rows!.map(r => String((r.after as { reverted?: unknown } | null)?.reverted ?? "").trim()).filter(Boolean);
  const receipts = new Map<string, MonthlyReportInput["work"]["refreshes"][number]>();
  let unverified = 0;
  for (const r of rewrites.rows!) {
    const a = (r.after ?? {}) as { url?: string; commit?: string; verified_at?: string; http_status?: unknown };
    const ok = !!a.commit?.trim() && !!a.url?.trim() && String(a.http_status) === "200" && !!a.verified_at && Number.isFinite(Date.parse(a.verified_at)) && !reverted.some(x => a.commit!.includes(x));
    if (ok) {
      const key = `${a.url!.toLowerCase()}|${a.commit!.trim()}`;
      if (!receipts.has(key)) receipts.set(key, { id: r.id, client_id: r.client_id, url: a.url!, verified_at: a.verified_at!, commit: a.commit!.trim() });
    } else unverified++;
  }

  const blogService = new Map(kw.rows.map(k => [k.id, k.service_id]));
  const published = social.rows!.filter(s => s.review_status !== "rejected");
  const sp = queue.rows!.filter(s => s.review_status !== "rejected");
  const labels = (i: { inquiry_sources: unknown }) => ((Array.isArray(i.inquiry_sources) ? i.inquiry_sources[0] : i.inquiry_sources) as { label: string } | null)?.label ?? null;
  const unit = (targets.data ?? []).filter(t => t.unit_kind === "client");

  return {
    error: null,
    data: {
      client: { id: client.id, name: client.name, website_url: client.website_url },
      brand: { primary: colors.rows!.find(x => x.role === "primary")?.hex ?? colors.rows![0]?.hex ?? null, tagline: brand.data?.tagline ?? null },
      scope, keywords, observations, runs: runs.rows!, grids,
      measurements: measurements.rows!,
      querySample: sample.rows!,
      inquiries: inquiries.rows!.map(i => ({ client_id: i.client_id, submitted_at: i.submitted_at, service_type: i.service_type, page_url: i.page_url, source: labels(i) })),
      inquiryCapture: { sources: inquirySources.rows!.length, enabled: inquirySources.rows!.filter(s => s.enabled).length },
      work: {
        blogs: blogs.rows!.map(b => {
          const s = service.get(blogService.get(b.keyword_id ?? "") ?? "");
          return { id: b.id, client_id: b.client_id, title: b.title, url: b.url, date: b.published_at!, service: s?.name ?? null, segment: s?.segment ?? null };
        }),
        social: published.map(s => ({
          id: s.id, client_id: s.client_id, platform: s.platform as "facebook" | "google_business",
          title: (s.copy ?? "").replace(/\s+/g, " ").trim().slice(0, 90) || "Post", url: s.published_url, date: s.published_at!,
          service: service.get(s.service_id ?? "")?.name ?? null, segment: service.get(s.service_id ?? "")?.segment ?? null,
        })),
        refreshes: [...receipts.values()],
        blogDraftsInReview: drafts.rows!.filter(d => d.deliverable === "blog").length,
        socialInReview: { facebook: sp.filter(s => s.review_status === "in_review" && s.platform === "facebook").length, gbp: sp.filter(s => s.review_status === "in_review" && s.platform === "google_business").length },
        socialApprovedUnpublished: sp.filter(s => s.review_status === "approved" && s.publish_status !== "published" && s.publish_status !== "failed").length,
        socialFailed: sp.filter(s => s.publish_status === "failed").length,
        refreshesUnverified: unverified,
      },
      targets: unit.length ? unit.map(t => ({ deliverable: t.deliverable, target: t.target, completed: t.completed, planned: t.planned, unverified: t.unverified, standard_version: t.standard_version, unit_kind: t.unit_kind })) : null,
    },
  };
}
