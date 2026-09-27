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
