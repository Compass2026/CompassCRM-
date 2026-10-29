/**
 * New Client Onboarding v1.0: pure helpers shared by the client Onboarding
 * tab, its server actions, the Control Center check and
 * tests/client-onboarding.test.mjs. The checklist lives in
 * client_onboarding_items (20261029170000); this file only reads it.
 *
 * Three things stay apart on every item:
 * - status: what a teammate recorded, with evidence (never set by a signal);
 * - signal: what existing records show (pipeline task, Citation Tracker
 *   listing, Search Console / GA4 imports, Zernio binding) — a hint, not a sign-off;
 * - blockers: the reason recorded on the item, or a dependency not yet done.
 */
import { sensitiveContent } from "./citations.ts";

export const SECTIONS = {
  identity: "A. Identity, site, brand and locations",
  search: "B. Search and analytics",
  citations: "C. Citations",
  social: "D. Social",
  website: "E. Website",
} as const;
export type Section = keyof typeof SECTIONS;

export const STATUSES = {
  not_started: "Not started",
  requested: "Access requested",
  in_progress: "In progress",
  submitted: "Created / submitted",
  claimed: "Claimed",
  connected: "Connected",
  verified: "Verified",
  needs_correction: "Needs correction",
  inaccessible: "Inaccessible",
  blocked: "Blocked",
  not_applicable: "Not applicable",
} as const;
export type OnboardingStatus = keyof typeof STATUSES;

/** Statuses that need evidence (the database enforces the same). */
export const EVIDENCE_STATUSES: OnboardingStatus[] = ["submitted", "claimed", "connected", "verified"];
/** Statuses only a listing-backed (citation) item can take. */
export const LISTING_STATUSES: OnboardingStatus[] = ["submitted", "claimed"];

export type OnboardingRow = {
  id: string; client_id: string; item_key: string; site_id: string | null; location_id: string | null;
  status: OnboardingStatus; required: boolean; owner: string; due_on: string | null;
  evidence_url: string | null; evidence_note: string; blocking_reason: string; next_action: string;
  last_verified_at: string | null; verified_by: string | null; updated_at: string;
  section: Section; scope: "client" | "site" | "location"; title: string; guidance: string; depends_on: string[];
  evidence_source: string | null; citation_directory_key: string | null; pipeline_task_key: string | null;
  sort_order: number; standard_version: string; item_active: boolean;
  scope_label: string | null; location_hide_address: boolean | null;
  pipeline_task_id: string | null; pipeline_task_status: string | null; pipeline_task_title: string | null;
  signal: Record<string, unknown> | null;
};

export const isDone = (r: Pick<OnboardingRow, "status">) => r.status === "verified" || r.status === "not_applicable";

/** Statuses a teammate may choose for an item (listing states only for citations). */
export function statusOptions(r: Pick<OnboardingRow, "citation_directory_key">): OnboardingStatus[] {
  return (Object.keys(STATUSES) as OnboardingStatus[]).filter((s) => r.citation_directory_key || !LISTING_STATUSES.includes(s));
}

/**
 * Dependencies are judged in the same scope where possible: a location item
 * waits on that location's rows, a site item on that site's; a client-scoped
 * dependency is shared. A dependency with no row at all (e.g. no site recorded
 * yet) counts as not done.
 */
export function waitingOn(row: OnboardingRow, rows: OnboardingRow[]): OnboardingRow[] {
  return row.depends_on.flatMap((key) => {
    const candidates = rows.filter((r) => r.client_id === row.client_id && r.item_key === key);
    const same = candidates.filter((r) =>
      (r.scope === "location" && r.location_id === row.location_id) ||
      (r.scope === "site" && r.site_id === row.site_id) || r.scope === "client");
    const pool = same.length ? same : candidates;
    return pool.length ? pool.filter((r) => !isDone(r)) : [];
  });
}

export type Outstanding = { row: OnboardingRow; reason: string; kind: "blocked" | "correction" | "overdue" };

/** Required, active items count; not applicable counts as done with its reason. */
export function summarize(rows: OnboardingRow[], today: string) {
  const counted = rows.filter((r) => r.required && r.item_active);
  const done = counted.filter(isDone).length;
  const outstanding: Outstanding[] = [];
  for (const r of counted) {
    if (isDone(r)) continue;
    if (r.status === "blocked") outstanding.push({ row: r, kind: "blocked", reason: r.blocking_reason });
    else if (r.status === "needs_correction" || r.status === "inaccessible") outstanding.push({ row: r, kind: "correction", reason: r.next_action });
    else if (r.due_on && r.due_on < today) outstanding.push({ row: r, kind: "overdue", reason: `Due ${r.due_on}` });
  }
  const bySection = Object.fromEntries((Object.keys(SECTIONS) as Section[]).map((s) => {
    const inSection = counted.filter((r) => r.section === s);
    return [s, { total: inSection.length, done: inSection.filter(isDone).length }];
  })) as Record<Section, { total: number; done: number }>;
  return { total: counted.length, done, outstanding, bySection, enrolled: rows.length > 0 };
}

const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const s = (v: unknown) => (typeof v === "string" ? v : "");

/** One line saying what existing records show. Never says "verified" on the item's behalf. */
export function signalText(r: Pick<OnboardingRow, "evidence_source" | "signal" | "scope_label">): string {
  const g = r.signal ?? {};
  switch (r.evidence_source) {
    case "access": return `Access tracker: ${n(g.granted)} granted, ${n(g.requested)} requested, ${n(g.not_needed)} not needed.`;
    case "location_identity": return g.status === "archived" ? "Location archived on Citations." : `Approved identity v${n(g.identity_version)}${g.hide_address ? " · street hidden (service area)" : " · public address"}.`;
    case "site": return s(g.url) ? `${s(g.url)} · ${g.controlled_by_compass ? "Compass-run" : "client-run"}.` : "No live URL on the site record.";
    case "gsc": return !s(g.property) ? "No Search Console property on the client." : g.data_through ? `${s(g.property)} · data through ${s(g.data_through)}.` : `${s(g.property)} · no import yet.`;
    case "ga4": {
      const parts = [s(g.property) || "No GA4 property on the client", s(g.measurement_id) ? `tag ${s(g.measurement_id)} on the site record` : "no measurement id on the site record"];
      return parts.join(" · ") + (g.data_through ? ` · data through ${s(g.data_through)}.` : " · no GA4 import yet.");
    }
    case "gbp_binding": return n(g.bound) ? `${n(g.verified)} of ${n(g.bound)} Business Profile locations bound through Zernio verified (client-wide).` : "No Business Profile location bound through Zernio.";
    case "facebook_binding": return n(g.bound) ? `${n(g.verified)} of ${n(g.bound)} Facebook Pages verified through Zernio; ${n(g.enabled)} publishing enabled.` : "No Facebook Page bound through Zernio.";
    case "citation": {
      if (!n(g.listings)) return "No listing recorded on the Citations tab for this location (not proof it does not exist).";
      const bits = [`${n(g.listings)} listing${n(g.listings) === 1 ? "" : "s"}`, `${n(g.verified)} verified accurate`];
      if (n(g.discrepancy)) bits.push(`${n(g.discrepancy)} need correction / reverification`);
      if (n(g.inaccessible)) bits.push(`${n(g.inaccessible)} inaccessible`);
      if (n(g.open_tasks)) bits.push(`${n(g.open_tasks)} open citation tasks`);
      return bits.join(" · ") + (g.last_checked_on ? ` · last checked ${s(g.last_checked_on)}.` : " · never checked.");
    }
    case "website_pipeline": {
      const mode = ({ new_build: "new build", upgrade_existing: "upgrade existing", client_retains: "client keeps the site" } as Record<string, string>)[s(g.work_mode)];
      return [mode ? `Work mode: ${mode}` : "No work mode recorded", g.pipeline_status ? `Website pipeline ${s(g.pipeline_status)}` : "not enrolled in Website",
        g.launched_at ? `launched ${s(g.launched_at).slice(0, 10)}` : "not launched"].join(" · ") + ".";
    }
    default: return "";
  }
}

/** Validates a teammate's update before it reaches the database guards. */
export function prepareUpdate(input: { status: string; evidence_url: string; evidence_note: string; blocking_reason: string; next_action: string; due_on: string; required: boolean; listing: boolean }) {
  if (!(input.status in STATUSES)) throw new Error("Choose a status.");
  const status = input.status as OnboardingStatus;
  if (!input.listing && LISTING_STATUSES.includes(status)) throw new Error("Created / submitted and claimed are listing states; use connected or verified here.");
  let evidence_url: string | null = null;
  if (input.evidence_url) {
    let u: URL;
    try { u = new URL(input.evidence_url); } catch { throw new Error("Evidence URL must be a complete https address."); }
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("Evidence URL must be a public address without credentials.");
    evidence_url = u.href;
  }
  for (const [label, v] of [["evidence", input.evidence_note], ["blocking reason", input.blocking_reason], ["next action", input.next_action], ["evidence URL", input.evidence_url]] as const) {
    if (sensitiveContent(v) || /\b(password|passwd|api[_ -]?key|secret|token)\s*[:=]/i.test(v)) throw new Error(`The ${label} looks like it contains a login or secret. Record who has access, never the credential.`);
  }
  if (EVIDENCE_STATUSES.includes(status) && !evidence_url && !input.evidence_note) throw new Error(`${STATUSES[status]} needs evidence: a URL or a note saying what was seen.`);
  if (status === "not_applicable" && !input.evidence_note) throw new Error("Say why this does not apply.");
  if (status === "blocked" && !input.blocking_reason) throw new Error("Say what is blocking it.");
  if ((status === "needs_correction" || status === "inaccessible") && !input.next_action) throw new Error("Say what the next action is.");
  if (input.due_on && !/^\d{4}-\d{2}-\d{2}$/.test(input.due_on)) throw new Error("Choose a valid due date.");
  return { status, evidence_url, evidence_note: input.evidence_note, blocking_reason: input.blocking_reason, next_action: input.next_action, due_on: input.due_on || null, required: input.required };
}

/** The Control Center's one-line check for a client. */
export function readinessState(rows: OnboardingRow[] | null, today: string): { state: "recorded" | "missing" | "unknown" | "blocked" | "waiting"; detail: string } {
  if (rows === null) return { state: "unknown", detail: "Onboarding checklist unavailable." };
  const sum = summarize(rows, today);
  if (!sum.enrolled) return { state: "missing", detail: "Not started: open the Onboarding tab to start the checklist." };
  const blocked = sum.outstanding.filter((o) => o.kind === "blocked" || o.kind === "correction").length;
  const detail = `${sum.done} of ${sum.total} required items verified or not applicable` + (blocked ? ` · ${blocked} blocked or needing correction` : "") + ".";
  return { state: sum.done === sum.total ? "recorded" : blocked ? "blocked" : "waiting", detail };
}
