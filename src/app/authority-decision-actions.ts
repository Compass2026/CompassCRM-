"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { listTeamMembers, requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { findCity } from "@/lib/us-cities";
import { callAuthorityRun } from "@/lib/authority-run-call";
import { sameSnapshot, type WorkflowSnapshot } from "@/lib/authority-lifecycle";
import {
  AUTHORITY_ONLY,
  CANONICAL_ACTIONS,
  DECISION_ACTIONS,
  MAX_SELECTED,
  appliedText,
  applyErrorText,
  decisionKind,
  defaultTask,
  intentRecommendation,
  marketPlace,
  normPlace,
  refreshPlan,
  serviceUrl,
  servicePath,
  suggestedServiceName,
  type DecisionAction,
} from "@/lib/authority-decisions";
import type { Opportunity } from "../../supabase/functions/authority/types";
import { normPath } from "../../supabase/functions/authority/urls";
import {
  MARKET_FIRST,
  RECONCILE_ACTIONS,
  mapRows,
  reconcileAction,
  reconcileServiceId,
  recordRows,
  rehomeRows,
  resultText,
  servicePageRow,
  type ApplyAnswer,
  type CurrentKeyword,
  type GroupRef,
  type Outcome,
  type PageFact,
  type ReconcileAction,
  type ReconcileRow,
  type ReportKeyword,
  type ServiceChoice,
  type TargetGroup,
} from "@/lib/authority-reconcile";

// Authority decisions (0049's authority_apply). Every action checks the
// caller is on the team first; authority_apply checks again, locks the
// opportunity and the rows it writes, compares them with what the preview
// showed and writes the decision, the suppression or link and the client
// data change in one transaction. After a change to client data an
// Authority refresh is started (never a full crawl).

type Supabase = Awaited<ReturnType<typeof createClient>>;
const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";
const CHANGED_SINCE_LOADED = "This opportunity changed since the page loaded. The page now shows its current state.";

export type PreviewRow = { label: string; before: string; after: string };
export type DecisionPreview =
  | {
      ok: true;
      action: DecisionAction;
      opportunityId: string;
      title: string;
      rows: PreviewRow[];
      note: string | null;
      expected: Record<string, unknown>;   // what the apply must still find
      payload: Record<string, unknown>;    // values the server worked out (coordinates, URL)
      fields: {
        reason?: { required: boolean; placeholder: string };
        name?: string; segment?: string | null; segments?: string[];
        title?: string; notes?: string; assignees?: { id: string; name: string }[];
      };
      refreshAfter: boolean;
    }
  | { ok: false; text: string; changed?: boolean };

type OppRow = {
  id: string; key: string; client_id: string; status: WorkflowSnapshot["status"]; suppressed: boolean; dismissed_until: string | null;
  present: boolean; last_seen_run_id: string; opportunity: Opportunity;
};

async function teammate(supabase: Supabase): Promise<boolean> {
  try { await requireTeamMember(supabase); return true; } catch { return false; }
}

async function readOpportunity(supabase: Supabase, clientId: string, opportunityId: string): Promise<OppRow | null> {
  const { data } = await supabase
    .from("authority_opportunities")
    .select("id, key, client_id, status, suppressed, dismissed_until, present, last_seen_run_id, opportunity")
    .eq("id", opportunityId)
    .eq("client_id", clientId)
    .maybeSingle();
  return (data as unknown as OppRow) ?? null;
}

const baseExpected = (o: OppRow) => ({ run_id: o.last_seen_run_id, status: o.status, suppressed: o.suppressed, dismissed_until: o.dismissed_until });

// ── Preview ─────────────────────────────────────────────────────────────────
export async function previewAuthorityDecisionAction(
  clientId: string, opportunityId: string, action: DecisionAction, page: WorkflowSnapshot, opts: { intent?: string } = {},
): Promise<DecisionPreview> {
  if (!isUuid(clientId) || !isUuid(opportunityId) || !DECISION_ACTIONS.includes(action)) return { ok: false, text: "Unknown decision." };
  const supabase = await createClient();
  if (!(await teammate(supabase))) return { ok: false, text: NOT_TEAM };
  const o = await readOpportunity(supabase, clientId, opportunityId);
  if (!o) return { ok: false, text: "This opportunity no longer exists.", changed: true };
  if (!o.present || !sameSnapshot(o, page)) return { ok: false, text: CHANGED_SINCE_LOADED, changed: true };
  const opp = o.opportunity;
  const kind = decisionKind(o.key);
  const expected: Record<string, unknown> = baseExpected(o);
  const base = { ok: true as const, action, opportunityId, expected, payload: {}, fields: {}, note: null, refreshAfter: CANONICAL_ACTIONS.includes(action) };

  if (action === "keep_intent" || action === "set_intent") {
    if (kind !== "intent") return { ok: false, text: "This is not an intent decision." };
    const rec = intentRecommendation(opp);
    if (!rec?.keywordId) return { ok: false, text: "The analysis did not name a keyword for this decision." };
    const { data: kw } = await supabase.from("keywords").select("id, keyword, intent").eq("id", rec.keywordId).eq("client_id", clientId).maybeSingle();
    if (!kw) return { ok: false, text: "The keyword is gone; refresh the analysis.", changed: true };
    if ((kw.intent ?? null) !== rec.stored) {
      return { ok: false, text: `The keyword's intent is now ${kw.intent ?? "none"}, not what the analysis saw; refresh the analysis first.`, changed: true };
    }
    expected.intent = kw.intent;
    if (action === "keep_intent") {
      return {
        ...base, title: `Keep “${kw.keyword}” as ${kw.intent}`,
        rows: [{ label: "keywords.intent", before: kw.intent ?? "—", after: `${kw.intent ?? "—"} (unchanged)` }],
        note: `This decision is suppressed while the analysis reads the query as ${rec.assessed}. If a later analysis recommends something different, it comes back.`,
      };
    }
    const intent = (opts.intent ?? "").toLowerCase();
    if (!rec.options.includes(intent)) return { ok: false, text: `Choose ${rec.options.join(" or ")}.` };
    return {
      ...base, title: `Change “${kw.keyword}” to ${intent}`, payload: { intent },
      rows: [{ label: "keywords.intent", before: kw.intent ?? "—", after: intent }],
      note: "Then an Authority refresh checks the result.",
    };
  }

  if (action === "approve_market" || action === "decline_market") {
    if (kind !== "market") return { ok: false, text: "This is not a market decision." };
    const place = marketPlace(opp);
    if (!place) return { ok: false, text: "The analysis did not name the place." };
    if (action === "decline_market") {
      return {
        ...base, title: `Decline ${place} as a market`, rows: [{ label: "locations", before: "—", after: "— (nothing written)" }],
        note: `Won't be recommended again until someone reopens it. ${AUTHORITY_ONLY}`,
        fields: { reason: { required: true, placeholder: "Why this market is not one they serve" } },
      };
    }
    const { data: client } = await supabase.from("clients").select("state").eq("id", clientId).maybeSingle();
    const state = (client?.state ?? "").toUpperCase();
    const city = state ? findCity(place, state) : null;
    if (!city) return { ok: false, text: `${place}${state ? `, ${state}` : ""} is not in the bundled city list, so it has no coordinates. Add the location on the Keywords tab instead.` };
    const { data: locs } = await supabase.from("locations").select("id, name, city, state, is_active, lat, lng").eq("client_id", clientId);
    const same = (locs ?? []).filter((l) => (l.state ?? "").toUpperCase() === city.state
      && (normPlace(l.city ?? "") === normPlace(city.name) || normPlace((l.name ?? "").replace(/,.*$/, "")) === normPlace(city.name)))
      .sort((a, b) => Number(b.is_active) - Number(a.is_active));
    const existing = same[0] ?? null;
    if (existing?.is_active) return { ok: false, text: `${city.name} is already an approved location; refresh the analysis.`, changed: true };
    expected.location_id = existing?.id ?? null;
    return {
      ...base, title: `Approve ${city.name}, ${city.state} as a market`,
      payload: { city: city.name, state: city.state, lat: city.lat, lng: city.lng },
      rows: [{
        label: "locations",
        before: existing ? `${existing.name} (not approved)` : "no row",
        after: `${city.name}, ${city.state} · approved · ${city.lat.toFixed(4)}, ${city.lng.toFixed(4)}`,
      }],
      note: "Then an Authority refresh checks the result.",
    };
  }

  if (action === "confirm_service" || action === "not_offered") {
    if (kind !== "service") return { ok: false, text: "This is not a service decision." };
    const path = servicePath(o.key)!;
    if (action === "not_offered") {
      return {
        ...base, title: `Not a service they offer: ${path}`, rows: [{ label: "services", before: "—", after: "— (nothing written)" }],
        note: `Won't be recommended again until someone reopens it. ${AUTHORITY_ONLY}`,
        fields: { reason: { required: true, placeholder: "Why this page is not a service they offer" } },
      };
    }
    const [{ data: client }, { data: services }] = await Promise.all([
      supabase.from("clients").select("website_url").eq("id", clientId).maybeSingle(),
      supabase.from("services").select("name, segment, status").eq("client_id", clientId),
    ]);
    const url = serviceUrl(client?.website_url ?? null, path);
    if (!url) return { ok: false, text: "Record the client's website first; the service page must be on it." };
    const segments = [...new Set((services ?? []).map((s) => s.segment).filter((s): s is string => !!s))].sort();
    const name = suggestedServiceName(opp);
    expected.service_id = null;
    return {
      ...base, title: `Confirm ${path} as a service`, payload: { page_url: url },
      rows: [{ label: "services", before: "no service owns this page", after: `approved service · ${url}` }],
      note: "Then an Authority refresh checks the result. Its keywords stay unmapped until they are mapped to it.",
      fields: { name, segment: segments[0] ?? null, segments },
    };
  }

  // create_task
  const { data: links } = await supabase.from("authority_opportunity_links").select("task_id").eq("opportunity_id", o.id).eq("kind", "task");
  const taskIds = (links ?? []).map((l) => l.task_id).filter((id): id is string => !!id);
  if (taskIds.length) {
    const { data: open } = await supabase.from("tasks").select("id").in("id", taskIds).neq("status", "done");
    if (open?.length) return { ok: false, text: "A task for this opportunity is already open.", changed: true };
  }
  const members = await listTeamMembers(supabase);
  const t = defaultTask(opp, opp.action === "create" ? "Create" : opp.action === "improve" ? "Improve" : "Work on");
  return {
    ...base, title: "Create a task", rows: [{ label: "tasks", before: "—", after: "a new TOM task, linked to this opportunity" }],
    note: "The task and its link are saved together. No analysis runs.",
    fields: { title: t.title, notes: t.notes, assignees: members.map((m) => ({ id: m.id, name: m.name ?? m.email })) },
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────
export type ApplyResult = { ok: true; text: string; refresh: { runId: string | null; text: string } | null } | { ok: false; text: string; changed: boolean };

async function refreshAfter(supabase: Supabase, clientId: string): Promise<{ runId: string | null; text: string }> {
  const { data: latest } = await supabase.from("authority_latest").select("inventory_stale, stale_sections").eq("client_id", clientId).maybeSingle();
  const plan = refreshPlan(latest ?? null);
  if (!plan.refresh) return { runId: null, text: plan.text };
  const outcome = await callAuthorityRun(supabase, clientId, "refresh");
  if (outcome.kind === "started") return { runId: outcome.runId, text: "Refreshing the analysis with the change." };
  if (outcome.kind === "running") return { runId: outcome.runId, text: "An analysis is already running and may predate this change; refresh again when it finishes." };
  return { runId: null, text: `Saved, but the refresh did not start: ${outcome.text}` };
}

async function applyOne(supabase: Supabase, clientId: string, opportunityId: string, action: DecisionAction, payload: Record<string, unknown>, expected: Record<string, unknown>) {
  const { data, error } = await supabase.rpc("authority_apply", {
    p_opportunity_id: opportunityId, p_action: action, p_payload: payload as never, p_expected: expected as never,
  });
  if (error) return { ok: false as const, ...applyErrorText(error) };
  const r = (data ?? {}) as { client_id?: string; canonical_change?: boolean };
  if (r.client_id && r.client_id !== clientId) return { ok: false as const, text: "That opportunity belongs to another client.", changed: true };
  return { ok: true as const, canonical: !!r.canonical_change };
}

export async function applyAuthorityDecisionAction(
  clientId: string, opportunityId: string, action: DecisionAction, payload: Record<string, unknown>, expected: Record<string, unknown>,
): Promise<ApplyResult> {
  if (!isUuid(clientId) || !isUuid(opportunityId) || !DECISION_ACTIONS.includes(action)) return { ok: false, text: "Unknown decision.", changed: false };
  const supabase = await createClient();
  if (!(await teammate(supabase))) return { ok: false, text: NOT_TEAM, changed: false };
  const r = await applyOne(supabase, clientId, opportunityId, action, payload, expected);
  revalidatePath(`/clients/${clientId}/authority`);
  if (!r.ok) return r;
  const text = appliedText(action, {
    intent: String(payload.intent ?? ""), city: String(payload.city ?? ""), name: String(payload.name ?? ""), title: String(payload.title ?? ""),
  });
  return { ok: true, text, refresh: r.canonical ? await refreshAfter(supabase, clientId) : null };
}

// Several markets approved (or declined) together: each is its own
// opportunity and its own transaction, at most 25, one refresh at the end.
export type BatchItem = { opportunityId: string; payload: Record<string, unknown>; expected: Record<string, unknown> };
export type BatchResult = { results: { opportunityId: string; ok: boolean; text: string }[]; refresh: { runId: string | null; text: string } | null } | { error: string };

export async function applyMarketsAction(clientId: string, action: "approve_market" | "decline_market", items: BatchItem[]): Promise<BatchResult> {
  if (!isUuid(clientId) || !Array.isArray(items) || !items.length) return { error: "Select at least one market." };
  if (items.length > MAX_SELECTED) return { error: `Select at most ${MAX_SELECTED} markets at a time.` };
  if (new Set(items.map((i) => i.opportunityId)).size !== items.length || items.some((i) => !isUuid(i.opportunityId))) return { error: "Unknown markets." };
  const supabase = await createClient();
  if (!(await teammate(supabase))) return { error: NOT_TEAM };
  const results: { opportunityId: string; ok: boolean; text: string }[] = [];
  let canonical = false;
  for (const it of items) {
    const r = await applyOne(supabase, clientId, it.opportunityId, action, it.payload, it.expected);
    canonical ||= r.ok && r.canonical;
    results.push({ opportunityId: it.opportunityId, ok: r.ok, text: r.ok ? appliedText(action, { city: String(it.payload.city ?? "") }) : r.text });
  }
  revalidatePath(`/clients/${clientId}/authority`);
  return { results, refresh: canonical ? await refreshAfter(supabase, clientId) : null };
}

// ── Reconciliation (C2: 0050 / 0051 / 0052's authority_apply actions) ───────
// The preview reads what authority_apply will read (the run's report and
// stored site snapshot, through the same SQL helpers) and shows every field
// each row writes. The apply sends exactly the ticked rows with the preview's
// expected state; authority_apply re-checks all of it in one transaction.
export type ReconcilePreview =
  | {
      ok: true;
      action: ReconcileAction;
      opportunityId: string;
      title: string;
      note: string | null;
      base: Record<string, unknown>;       // the opportunity's expected workflow
      rows: ReconcileRow[];
      selects: boolean;                    // rows are ticked (none preselected)
    }
  | { ok: false; text: string; changed?: boolean };

type GroupRow = { id: string; name: string; page_type: string; target_url: string | null; primary_keyword_id: string | null; supporting_keyword_ids: string[] | null; status: string };

async function pageState(supabase: Supabase, runId: string, path: string | null): Promise<{ state: string; page: Record<string, unknown> | null }> {
  if (!path) return { state: "not_checked", page: null };
  const { data } = await supabase.rpc("authority_page_state" as never, { p_run_id: runId, p_path: path } as never);
  const d = (data ?? {}) as { state?: string; page?: Record<string, unknown> };
  return { state: d.state ?? "not_checked", page: d.page ?? null };
}
// The approved page group that serves a service, exactly as authority_apply finds it.
async function serviceGroup(supabase: Supabase, runId: string, site: string | null, clientId: string, name: string): Promise<TargetGroup | null> {
  const { data } = await supabase.rpc("authority_service_group" as never, { p_client_id: clientId, p_service_name: name } as never);
  const g = data as unknown as GroupRow | null;
  if (!g?.id) return null;
  const path = normPath(g.target_url, site);
  return { id: g.id, name: g.name, target_url: g.target_url, path, live: (await pageState(supabase, runId, path)).state === "live" };
}
// authority_apply's title rule for a recorded page: the H1, else the title without its site suffix, else the path.
function pageTitle(page: Record<string, unknown> | null, path: string): string {
  const h1 = typeof page?.h1 === "string" ? page.h1.trim() : "";
  const t = typeof page?.title === "string" ? page.title.replace(/\s+[|–—-]\s+[^|–—-]*$/, "").trim() : "";
  return (h1 || t || path).slice(0, 300);
}

export async function previewReconcileAction(clientId: string, opportunityId: string, action: ReconcileAction, page: WorkflowSnapshot): Promise<ReconcilePreview> {
  if (!isUuid(clientId) || !isUuid(opportunityId) || !RECONCILE_ACTIONS.includes(action)) return { ok: false, text: "Unknown reconciliation." };
  const supabase = await createClient();
  if (!(await teammate(supabase))) return { ok: false, text: NOT_TEAM };
  const o = await readOpportunity(supabase, clientId, opportunityId);
  if (!o) return { ok: false, text: "This opportunity no longer exists.", changed: true };
  if (!o.present || !sameSnapshot(o, page)) return { ok: false, text: CHANGED_SINCE_LOADED, changed: true };
  if (reconcileAction(o.key) !== action) return { ok: false, text: "This reconciliation does not apply to this opportunity." };
  if (o.status === "dismissed") return { ok: false, text: "Reopen this opportunity before reconciling it." };
  const runId = o.last_seen_run_id;
  const { data: run } = await supabase.from("authority_runs").select("site:inventory->>site").eq("id", runId).maybeSingle();
  const site = ((run as { site?: string | null } | null)?.site) ?? null;
  const base = baseExpected(o);
  const common = { ok: true as const, action, opportunityId, base };

  if (action === "set_service_page") {
    const svcId = reconcileServiceId(o.key)!;
    const { data: svc } = await supabase.from("services").select("id, name, status, page_url").eq("id", svcId).eq("client_id", clientId).maybeSingle();
    const group = svc ? await serviceGroup(supabase, runId, site, clientId, svc.name) : null;
    const row = servicePageRow({ service: svc ? { ...svc, page_path: normPath(svc.page_url, site) } : null, group });
    return { ...common, title: `Set ${svc?.name ?? "the service"}'s service page`, selects: false, rows: [row],
      note: "Writes one field on the service record. Then one Authority refresh checks the result." };
  }

  const { data: rep } = await supabase.from("authority_runs").select("keywords:report->keywords").eq("id", runId).maybeSingle();
  const report = (((rep as { keywords?: ReportKeyword[] } | null)?.keywords) ?? []) as ReportKeyword[];
  const currentOf = async (ids: string[]) => {
    const out = new Map<string, CurrentKeyword>();
    if (!ids.length) return out;
    const { data } = await supabase.from("keywords").select("id, keyword, service_id, target_url").eq("client_id", clientId).in("id", ids);
    for (const k of data ?? []) out.set(k.id, { ...k, target_path: normPath(k.target_url, site) });
    return out;
  };
  const { data: present } = await supabase.from("authority_opportunities").select("key").eq("client_id", clientId).eq("present", true);
  const presentKeys = new Set((present ?? []).map((x) => x.key));

  if (action === "rehome_keywords") {
    const svcId = reconcileServiceId(o.key)!;
    const { data: svc } = await supabase.from("services").select("id, name, status").eq("id", svcId).eq("client_id", clientId).maybeSingle();
    if (!svc || svc.status !== "approved") return { ok: false, text: "The service is gone or not approved; refresh the analysis.", changed: true };
    const ids = report.filter((k) => k.service_id === svc.id && k.flags.includes("homepage_pollution")).map((k) => k.keyword_id);
    const [current, group, groupsQ, primQ] = await Promise.all([
      currentOf(ids),
      serviceGroup(supabase, runId, site, clientId, svc.name),
      supabase.from("page_groups").select("id, name, page_type, target_url, primary_keyword_id, supporting_keyword_ids, status").eq("client_id", clientId),
      supabase.from("services").select("primary_keyword_id").eq("client_id", clientId).not("primary_keyword_id", "is", null),
    ]);
    const groups = (groupsQ.data ?? []) as GroupRow[];
    const homes = groups.filter((g) => g.page_type === "home" && g.status === "approved");
    const h = homes.length === 1 ? homes[0] : null;
    const hPath = h ? normPath(h.target_url, site) : null;
    const home = h ? {
      id: h.id, name: h.name, target_url: h.target_url, path: hPath, live: true, primary: h.primary_keyword_id, supporting: h.supporting_keyword_ids ?? [],
      valid: hPath === "/", reason: hPath === "/" ? null : "The Home page group does not target the home page.",
    } : homes.length > 1 ? { id: "", name: "Home", target_url: null, path: null, live: false, primary: null, supporting: [], valid: false, reason: "Home needs exactly one approved Home page group." } : null;
    const svcGroups = groups.filter((g) => g.page_type === "service" || g.page_type === "hub");
    const primaryIds = new Set<string>([
      ...(primQ.data ?? []).map((x) => x.primary_keyword_id as string),
      ...svcGroups.map((g) => g.primary_keyword_id).filter((x): x is string => !!x),
    ]);
    const listing = new Map<string, GroupRef[]>();
    for (const id of ids) {
      listing.set(id, svcGroups.filter((g) => (g.supporting_keyword_ids ?? []).includes(id)).sort((a, b) => a.id.localeCompare(b.id)).map((g) => ({ id: g.id, name: g.name })));
    }
    const ownerKeys = new Set([...presentKeys].filter((k) => k.startsWith("confirm_owner:")));
    const rows = rehomeRows({ service: { id: svc.id, name: svc.name }, report, current, serviceGroup: group, home, primaryIds, listing, ownerKeys });
    return { ...common, title: `Re-home ${svc.name}'s home-page keywords`, selects: true, rows,
      note: "Each ticked keyword goes where the analysis placed it: Home, or the service's own page. The batch is all or nothing; then one Authority refresh checks it." };
  }

  if (action === "record_content") {
    const candidates = o.opportunity.candidate_paths;
    const [{ data: siteRow }, { data: posts }] = await Promise.all([
      supabase.from("sites").select("content_paths, created_at").eq("client_id", clientId).order("created_at").limit(1).maybeSingle(),
      supabase.from("content_posts").select("url").eq("client_id", clientId),
    ]);
    const route = ((siteRow?.content_paths ?? null) as { blog_route?: string } | null)?.blog_route ?? "";
    const brace = route.indexOf("{");
    const prefix = brace > 0 ? route.slice(0, brace) : "/blog/";
    const recorded = new Set((posts ?? []).map((p) => normPath(p.url, site)).filter((x): x is string => !!x));
    const pages = new Map<string, PageFact>();
    await Promise.all((candidates ?? []).map(async (path) => {
      const st = await pageState(supabase, runId, path);
      const url = typeof st.page?.final_url === "string" && st.page.final_url ? st.page.final_url : typeof st.page?.url === "string" ? st.page.url : null;
      pages.set(path, { state: st.state, title: pageTitle(st.page, path), url });
    }));
    const rows = recordRows({ candidates, prefix, pages, recorded });
    if (!rows) return { ok: false, text: "This analysis predates the structured page list. Refresh the analysis to list the pages." };
    return { ...common, title: "Record existing pages from the client's site", selects: true, rows,
      note: "Each ticked page becomes a published content_posts row with origin site_inventory: it counts for Authority coverage but never as Compass's work (reports, Content tab, client portal). A page someone records meanwhile is skipped, not duplicated. Then one Authority refresh checks it." };
  }

  // map_keywords
  const ids = report.filter((k) => k.role === "unmapped").map((k) => k.keyword_id);
  const [current, { data: svcs }] = await Promise.all([
    currentOf(ids),
    supabase.from("services").select("id, name").eq("client_id", clientId).eq("status", "approved").order("name"),
  ]);
  const services: ServiceChoice[] = await Promise.all((svcs ?? []).map(async (s) => ({ id: s.id, name: s.name, group: await serviceGroup(supabase, runId, site, clientId, s.name) })));
  const marketKeys = new Map<string, string>();
  for (const k of presentKeys) if (k.startsWith("confirm_market:")) marketKeys.set(k.slice("confirm_market:".length), k);
  const rows = mapRows({ report, current, services, marketKeys, normPlace: (p) => normPlace(p).replace(/ /g, "-") });
  return { ...common, title: "Map unmapped keywords to services", selects: true, rows,
    note: `Pick a service for each ticked keyword; only approved services with a live page are offered. ${MARKET_FIRST.replace("This keyword", "A keyword that")} The batch is all or nothing; then one Authority refresh checks it.` };
}

export type ReconcileResult =
  | { ok: true; outcome: Outcome; refresh: { runId: string | null; text: string } | null }
  | { ok: false; text: string; changed: boolean };

export async function applyReconcileAction(
  clientId: string, opportunityId: string, action: ReconcileAction, payload: Record<string, unknown>, expected: Record<string, unknown>, ctx: { service?: string } = {},
): Promise<ReconcileResult> {
  if (!isUuid(clientId) || !isUuid(opportunityId) || !RECONCILE_ACTIONS.includes(action)) return { ok: false, text: "Unknown reconciliation.", changed: false };
  const list = (action === "record_content" ? payload.paths : payload.rows) as unknown;
  if (action !== "set_service_page") {
    if (!Array.isArray(list) || list.length < 1) return { ok: false, text: "Tick at least one row.", changed: false };
    if (list.length > MAX_SELECTED) return { ok: false, text: `Select at most ${MAX_SELECTED} rows at a time.`, changed: false };
  }
  const supabase = await createClient();
  if (!(await teammate(supabase))) return { ok: false, text: NOT_TEAM, changed: false };
  const { data, error } = await supabase.rpc("authority_apply", {
    p_opportunity_id: opportunityId, p_action: action, p_payload: payload as never, p_expected: expected as never,
  });
  revalidatePath(`/clients/${clientId}/authority`);
  if (error) return { ok: false, ...applyErrorText(error) };
  const r = (data ?? {}) as ApplyAnswer & { client_id?: string };
  if (r.client_id && r.client_id !== clientId) return { ok: false, text: "That opportunity belongs to another client.", changed: true };
  const outcome = resultText(action, r, ctx);
  return { ok: true, outcome, refresh: r.canonical_change ? await refreshAfter(supabase, clientId) : null };
}
