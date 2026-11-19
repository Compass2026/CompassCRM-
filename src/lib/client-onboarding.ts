/**
 * New Client Onboarding v1.0: pure helpers shared by the client Onboarding
 * tab, its server actions, the Control Center check and
 * tests/client-onboarding.test.mjs. The checklist lives in
 * client_onboarding_items (20261029170000); this file only reads it.
 *
 * Kept apart on every item:
 * - status: what a teammate recorded, with evidence (never set by a signal);
 * - signal: what existing records show. "exact" signals are about this site /
 *   location / named account; "unlinked" ones are client-wide counts and never
 *   evidence for one site or location;
 * - blockers: the reason on the item, a prerequisite not done or missing in
 *   the same scope, or a gap in the client's scope (client_onboarding_gaps).
 * Nothing is complete by omission: a missing row is a gap, never "done".
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
/** Items that name the exact bound account they are about. */
export const ACCOUNT_SOURCES: Record<string, "google_business" | "facebook"> = { gbp_binding: "google_business", facebook_binding: "facebook" };

export type OnboardingRow = {
  id: string; client_id: string; item_key: string; site_id: string | null; location_id: string | null; social_account_id: string | null;
  status: OnboardingStatus; required: boolean; owner: string; due_on: string | null;
  evidence_url: string | null; evidence_note: string; blocking_reason: string; next_action: string;
  last_verified_at: string | null; verified_by: string | null; updated_at: string;
  section: Section; scope: "client" | "site" | "location"; title: string; guidance: string; depends_on: string[];
  evidence_source: string | null; citation_directory_key: string | null; pipeline_task_key: string | null;
  sort_order: number; standard_version: string; item_active: boolean;
  scope_label: string | null; location_hide_address: boolean | null; location_status: string | null; client_service_scope: string;
  pipeline_task_id: string | null; pipeline_task_status: string | null; pipeline_task_title: string | null;
  signal: Record<string, unknown> | null;
};

export const GAP_KINDS = {
  no_site: "No website decided",
  site_after_none: "Site recorded after \"no website\"",
  no_location: "No business location decided",
  location_after_none: "Location approved after \"none eligible\"",
  site_missing_items: "Site missing checklist items",
  location_missing_items: "Location missing checklist items",
} as const;
export type OnboardingGap = { client_id: string; kind: keyof typeof GAP_KINDS; target_id: string | null; label: string | null; detail: string };

export const isDone = (r: Pick<OnboardingRow, "status">) => r.status === "verified" || r.status === "not_applicable";
/** Rows of an archived business location are history, not part of the checklist. */
const counts = (r: OnboardingRow) => r.item_active && r.location_status !== "archived";

/** Statuses a teammate may choose for an item (listing states only for citations). */
export function statusOptions(r: Pick<OnboardingRow, "citation_directory_key">): OnboardingStatus[] {
  return (Object.keys(STATUSES) as OnboardingStatus[]).filter((s) => r.citation_directory_key || !LISTING_STATUSES.includes(s));
}

export type Prerequisite = { key: string; title: string; missing: boolean; row: OnboardingRow | null };

/**
 * A row's prerequisites, judged exactly as the database does: a client-scoped
 * dependency is the client's row; any other is the row for this same site or
 * location. No row there is a missing prerequisite, never satisfied, and
 * another site's or location's row never stands in.
 */
export function prerequisites(row: OnboardingRow, rows: OnboardingRow[]): Prerequisite[] {
  return row.depends_on.map((key) => {
    const same = rows.filter((r) => r.client_id === row.client_id && r.item_key === key);
    const any = rows.find((r) => r.item_key === key);
    const match = same.find((r) => r.scope === "client" || (r.scope === "site" && r.site_id === row.site_id) || (r.scope === "location" && r.location_id === row.location_id)) ?? null;
    return { key, title: any?.title ?? key, missing: !match, row: match };
  });
}
/** Prerequisites that are missing or not done. */
export const unmet = (row: OnboardingRow, rows: OnboardingRow[]) => prerequisites(row, rows).filter((p) => p.missing || !isDone(p.row!));
/** Not applicable (with its reason), or verified with every prerequisite done. A sign-off whose prerequisite was reopened is not counted. */
export const isComplete = (row: OnboardingRow, rows: OnboardingRow[]) =>
  row.status === "not_applicable" || (row.status === "verified" && unmet(row, rows).length === 0);

export type Outstanding = { id: string; title: string; scope_label: string | null; reason: string;
  kind: "gap" | "blocked" | "correction" | "missing_prerequisite" | "reopened_prerequisite" | "overdue"; row: OnboardingRow | null };

/** Required, active items count; not applicable counts as done with its reason. Gaps keep a client incomplete. */
export function summarize(rows: OnboardingRow[], gaps: OnboardingGap[], today: string) {
  const counted = rows.filter((r) => r.required && counts(r));
  const done = counted.filter((r) => isComplete(r, rows)).length;
  const outstanding: Outstanding[] = gaps.map((g) => ({
    id: `gap:${g.kind}:${g.target_id ?? ""}`, title: GAP_KINDS[g.kind] ?? g.kind, scope_label: g.label, reason: g.detail, kind: "gap", row: null,
  }));
  for (const r of counted) {
    const o = (kind: Outstanding["kind"], reason: string) => outstanding.push({ id: r.id, title: r.title, scope_label: r.scope === "client" ? null : r.scope_label, reason, kind, row: r });
    const open = unmet(r, rows);
    if (isDone(r)) {
      if (r.status === "verified" && open.length) o("reopened_prerequisite", `Verified, but ${open.map((p) => `"${p.title}"`).join(", ")} is ${open.some((p) => p.missing) ? "missing" : "no longer done"}.`);
      continue;
    }
    if (r.status === "blocked") o("blocked", r.blocking_reason);
    else if (r.status === "needs_correction" || r.status === "inaccessible") o("correction", r.next_action);
    else if (open.some((p) => p.missing)) o("missing_prerequisite", `No checklist row for ${open.filter((p) => p.missing).map((p) => `"${p.title}"`).join(", ")} here; run "Add missing items".`);
    else if (r.due_on && r.due_on < today) o("overdue", `Due ${r.due_on}`);
  }
  const bySection = Object.fromEntries((Object.keys(SECTIONS) as Section[]).map((s) => {
    const inSection = counted.filter((r) => r.section === s);
    return [s, { total: inSection.length, done: inSection.filter((r) => isComplete(r, rows)).length }];
  })) as Record<Section, { total: number; done: number }>;
  const enrolled = rows.length > 0;
  return { total: counted.length, done, outstanding, bySection, enrolled, gaps: gaps.length, complete: enrolled && gaps.length === 0 && done === counted.length };
}

const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const s = (v: unknown) => (typeof v === "string" ? v : "");

/** One line saying what existing records show. Never says "verified" on the item's behalf; client-wide counts say so. */
export function signalText(r: Pick<OnboardingRow, "evidence_source" | "signal" | "scope_label" | "item_key">): string {
  const g = r.signal ?? {};
  switch (r.evidence_source) {
    case "access": return `Access tracker: ${n(g.granted)} granted, ${n(g.requested)} requested, ${n(g.not_needed)} not needed.`;
    case "scope": return r.item_key === "scope_sites" ? `${n(g.records)} site record${n(g.records) === 1 ? "" : "s"}.` : `${n(g.records)} approved business location${n(g.records) === 1 ? "" : "s"} on Citations.`;
    case "location_identity": return g.status === "archived" ? "Location archived on Citations." : `Approved identity v${n(g.identity_version)}${g.hide_address ? " · street hidden (service area)" : " · public address"}.`;
    case "site": return s(g.url) ? `${s(g.url)} · ${g.controlled_by_compass ? "Compass-run" : "client-run"}.` : "No live URL on the site record.";
    case "gsc": {
      if (!s(g.host)) return "This site has no live URL on its record, so its own Search Console data cannot be matched.";
      const own = s(g.property) ? `${s(g.property)} · data through ${s(g.data_through)}.` : `No Search Console import for ${s(g.host)} yet.`;
      return own + (s(g.client_property) && !s(g.property) ? ` Client-wide property ${s(g.client_property)} is not evidence for this site.` : "");
    }
    case "ga4": {
      if (!s(g.host)) return "This site has no live URL on its record, so its own GA4 data cannot be matched.";
      const tag = s(g.measurement_id) ? `tag ${s(g.measurement_id)} on the site record` : "no measurement id on the site record";
      const data = s(g.property) ? `${s(g.property)} data for ${s(g.host)} through ${s(g.data_through)}` : `no GA4 import filtered to ${s(g.host)} yet`;
      return `${tag} · ${data}.` + (s(g.client_property) && !s(g.property) ? ` Client-wide property ${s(g.client_property)} is not evidence for this site.` : "");
    }
    case "gbp_binding": {
      const listings = n(g.gbp_listings) ? ` · ${n(g.gbp_listings)} GBP listing${n(g.gbp_listings) === 1 ? "" : "s"} recorded for this location` : "";
      if (g.scope === "exact") return `Named profile ${s(g.name) || s(g.account)} (${s(g.account)}): ${s(g.provider) === "zernio" && g.verified_at ? "bound through Zernio and verified" : "not connected through Zernio"}${listings}.`;
      return `No Business Profile named for this location${listings}. Client-wide: ${n(g.verified)} of ${n(g.bound)} Zernio locations verified — not evidence for this location.`;
    }
    case "facebook_binding": {
      if (g.scope === "exact") return `Named Page ${s(g.name) || s(g.account)}: ${s(g.provider) === "zernio" && g.verified_at ? "bound through Zernio and verified" : "not connected through Zernio"}${g.enabled ? " · publishing enabled" : " · publishing off"}.`;
      return `No Facebook Page named for this site${g.expected_account ? " (this brand has its own Page)" : ""}. Client-wide: ${n(g.verified)} of ${n(g.bound)} Pages verified — not evidence for this site.`;
    }
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates a teammate's update before it reaches the database guards. */
export function prepareUpdate(input: { status: string; evidence_url: string; evidence_note: string; blocking_reason: string; next_action: string; due_on: string; required: boolean; listing: boolean; account?: string | null; accountItem?: boolean }) {
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
  const out = { status, evidence_url, evidence_note: input.evidence_note, blocking_reason: input.blocking_reason, next_action: input.next_action, due_on: input.due_on || null, required: input.required };
  if (!input.accountItem) {
    if (input.account) throw new Error("Only Business Profile and Facebook items name an account.");
    return out;
  }
  if (input.account && !UUID.test(input.account)) throw new Error("Choose the account from the list.");
  return { ...out, social_account_id: input.account || null };
}

/** The Control Center's one-line check for a client. Recorded only when every required item is done and nothing is missing. */
export function readinessState(rows: OnboardingRow[] | null, gaps: OnboardingGap[] | null, today: string): { state: "recorded" | "missing" | "unknown" | "blocked" | "waiting"; detail: string } {
  if (rows === null || gaps === null) return { state: "unknown", detail: "Onboarding checklist unavailable." };
  const sum = summarize(rows, gaps, today);
  if (!sum.enrolled) return { state: "missing", detail: "Not started: open the Onboarding tab to start the checklist." };
  const blocked = sum.outstanding.filter((o) => o.kind !== "overdue").length;
  const detail = `${sum.done} of ${sum.total} required items done` + (sum.gaps ? ` · ${sum.gaps} scope gap${sum.gaps === 1 ? "" : "s"}` : "")
    + (blocked - sum.gaps > 0 ? ` · ${blocked - sum.gaps} blocked or missing a prerequisite` : "") + ".";
  return { state: sum.complete ? "recorded" : blocked ? "blocked" : "waiting", detail };
}
