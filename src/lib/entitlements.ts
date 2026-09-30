// The entitlement contract (B5): what Compass has agreed to deliver to a
// client, for every Compass system that plans or shows work. It reads one
// thing — client_entitlements_for() (0062), derived from the agreement's
// package and the client's overrides — and never billing: a past-due or
// canceled Stripe subscription does not change what is included, and nothing
// here knows about Stripe, invoices or payments.
//
// Rules every consumer follows:
//   - A feature (seo, gbp, social, …) is included when enabled.
//   - A quota (blog_posts, …) is included when enabled with a quantity; that
//     quantity is the monthly allocation automated planning works to.
//   - Disabled, absent or unknown means not included: allocation 0. Never
//     "unlimited", never a default number.
//   - The allocation guides automation only. A person may always create more
//     work by hand; nothing here or in the database refuses it.
//   - If entitlements cannot be read, automated planning stops for that
//     client (EntitlementsUnavailable) instead of guessing.
//
// Pure except for the get* loaders, which take a Supabase client (any object
// with rpc(), so tests pass a fake).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.ts";

export const FEATURE_KEYS = ["seo", "website", "hosting", "gbp", "social", "paid_ads", "crm", "reporting", "client_portal"] as const;
export const QUOTA_KEYS = ["blog_posts", "website_pages", "website_refreshes", "gbp_posts", "social_posts"] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];
export type QuotaKey = typeof QUOTA_KEYS[number];
export type ServiceKey = FeatureKey | QuotaKey;

export type EntitlementSource = "package" | "client_override" | "none";

export type EntitlementRow = {
  client_id: string;
  service_key: string;
  service_name: string;
  kind: "feature" | "quota";
  enabled: boolean;
  quantity: number | null;
  unit: string | null;
  period: string | null;
  source: EntitlementSource;
  package_id: string | null;
};

export type Entitlement = {
  key: string;
  name: string;
  kind: "feature" | "quota";
  enabled: boolean;
  quantity: number | null;
  unit: string | null;
  period: string | null;
  source: EntitlementSource;
};

export type EntitlementSet = {
  clientId: string;
  packageId: string | null;
  byKey: Record<string, Entitlement>;
};

export class EntitlementsUnavailable extends Error {
  constructor(clientId: string | null, reason: string) {
    super(`Entitlements unavailable${clientId ? ` for client ${clientId}` : ""}: ${reason}`);
  }
}

export function isQuotaKey(key: string): key is QuotaKey {
  return (QUOTA_KEYS as readonly string[]).includes(key);
}

// Rows for one client → the set consumers read.
export function entitlementSet(clientId: string, rows: EntitlementRow[]): EntitlementSet {
  const byKey: Record<string, Entitlement> = {};
  let packageId: string | null = null;
  for (const r of rows) {
    if (r.client_id !== clientId) continue;
    packageId = packageId ?? r.package_id;
    byKey[r.service_key] = {
      key: r.service_key, name: r.service_name, kind: r.kind, enabled: !!r.enabled,
      quantity: r.quantity, unit: r.unit, period: r.period, source: r.source,
    };
  }
  return { clientId, packageId, byKey };
}

// Is a feature (or a quota with an allocation) part of the agreement?
export function includes(set: EntitlementSet, key: ServiceKey): boolean {
  const e = set.byKey[key];
  if (!e || !e.enabled) return false;
  return e.kind === "feature" ? true : (e.quantity ?? 0) > 0;
}

// The agreed monthly allocation for a quota: 0 when disabled, absent or unknown.
export function monthlyAllocation(set: EntitlementSet, key: QuotaKey): number {
  const e = set.byKey[key];
  if (!e || !e.enabled || e.kind !== "quota") return 0;
  return Math.max(0, e.quantity ?? 0);
}

// Allocation minus what already exists for the period (planned or done).
// Never negative: work beyond a lowered allocation is kept, not removed.
export function remainingAllocation(allocation: number, existing: number): number {
  return Math.max(0, allocation - Math.max(0, existing));
}

// The included services and monthly deliverables, in catalog order, for
// context (Client Intelligence, the portal) — only what is included.
export function includedServices(set: EntitlementSet): Entitlement[] {
  return Object.values(set.byKey).filter((e) => e.kind === "feature" && e.enabled);
}
export function monthlyDeliverables(set: EntitlementSet): Entitlement[] {
  return Object.values(set.byKey).filter((e) => e.kind === "quota" && e.enabled && (e.quantity ?? 0) > 0);
}

// Service context for Client Intelligence and the portal: what is in the
// agreement, what is delivered monthly, and what is not included.
export type ServiceScope = { included: string[]; monthly: string[]; notIncluded: string[] };
export function serviceScope(set: EntitlementSet): ServiceScope {
  const all = Object.values(set.byKey);
  return {
    included: includedServices(set).map((e) => e.name),
    monthly: monthlyDeliverables(set).map(deliverableText),
    notIncluded: all.filter((e) => !(e.kind === "feature" ? e.enabled : e.enabled && (e.quantity ?? 0) > 0)).map((e) => e.name),
  };
}

// "4 Blog Posts / month"
export function deliverableText(e: Pick<Entitlement, "name" | "quantity" | "period">): string {
  return `${e.quantity ?? 0} ${e.name}${e.period ? ` / ${e.period}` : ""}`;
}

// ── Monthly quota accounting (client_quota_usage, 0062) ──────────────────
// completed + planned = used; remaining = max(0, allocation − used) is what
// automation may still add this month; over_allocation is work beyond the
// allocation (a person added it, or the allocation was lowered) — kept,
// never removed.
export type QuotaUsage = {
  clientId: string;
  key: QuotaKey;
  name: string;
  month: string;                           // yyyy-mm-01 (America/Chicago month)
  allocation: number;
  completed: number;
  planned: number;
  used: number;
  remaining: number;
  overAllocation: number;
};
export type QuotaUsageRow = {
  client_id: string; service_key: string; service_name: string; month: string;
  allocation: number; completed: number; planned: number; used: number; remaining: number; over_allocation: number;
};

export function quotaUsage(row: QuotaUsageRow): QuotaUsage | null {
  if (!isQuotaKey(row.service_key)) return null;
  return {
    clientId: row.client_id, key: row.service_key, name: row.service_name, month: row.month,
    allocation: row.allocation ?? 0, completed: row.completed ?? 0, planned: row.planned ?? 0,
    used: row.used ?? 0, remaining: row.remaining ?? 0, overAllocation: row.over_allocation ?? 0,
  };
}

// The same arithmetic as the SQL, for callers that count work themselves.
export function usageFrom(allocation: number, completed: number, planned: number): Pick<QuotaUsage, "allocation" | "completed" | "planned" | "used" | "remaining" | "overAllocation"> {
  const used = Math.max(0, completed) + Math.max(0, planned);
  return { allocation, completed, planned, used, remaining: remainingAllocation(allocation, used), overAllocation: Math.max(0, used - allocation) };
}

// "3 / 4 planned" — this month's work against the allocation; "not included"
// when the agreement has none. Work beyond it reads "5 / 4 planned".
export function targetText(u: Pick<QuotaUsage, "allocation" | "used">): string {
  if (u.allocation <= 0) return u.used > 0 ? `${u.used} (not included)` : "not included";
  return `${u.used} / ${u.allocation} planned`;
}

// ── Planning within the agreement ─────────────────────────────────────────
// The kinds of work Compass automates, and what the agreement must include
// for automation to plan each one. A person may still do any of them.
export type WorkKind = "gbp_post" | "social_post" | "blog_post" | "new_page" | "page_refresh";
export const WORK_REQUIREMENTS: Record<WorkKind, { feature: FeatureKey | null; quota: QuotaKey }> = {
  gbp_post: { feature: "gbp", quota: "gbp_posts" },
  social_post: { feature: "social", quota: "social_posts" },
  blog_post: { feature: null, quota: "blog_posts" },
  new_page: { feature: "website", quota: "website_pages" },
  page_refresh: { feature: "website", quota: "website_refreshes" },
};

export type PlanDecision = {
  status: "within_allocation" | "not_in_agreement" | "allocation_used";
  allowed: number;                         // how many automation may plan now (≤ wanted)
  allocation: number;
  used: number;
  remaining: number;
};

// May automation plan `wanted` more of this kind this month? Never more than
// what remains; nothing when the feature or the quota is not agreed.
export function planWork(set: EntitlementSet, usage: Partial<Record<QuotaKey, Pick<QuotaUsage, "used">>>, kind: WorkKind, wanted = 1): PlanDecision {
  const req = WORK_REQUIREMENTS[kind];
  const allocation = monthlyAllocation(set, req.quota);
  const used = usage[req.quota]?.used ?? 0;
  const remaining = remainingAllocation(allocation, used);
  const featureOk = req.feature == null || includes(set, req.feature);
  if (!featureOk || allocation === 0) return { status: "not_in_agreement", allowed: 0, allocation, used, remaining: 0 };
  if (remaining === 0) return { status: "allocation_used", allowed: 0, allocation, used, remaining };
  return { status: "within_allocation", allowed: Math.min(Math.max(0, wanted), remaining), allocation, used, remaining };
}

// ── Loaders (one read per client, or one read for many) ───────────────────
// The typed Supabase client (tests pass a fake with the same rpc()).
type Reader = SupabaseClient<Database>;

export async function getClientEntitlements(supabase: Reader, clientId: string): Promise<EntitlementSet> {
  const { data, error } = await supabase.rpc("client_entitlements_for", { p_client_id: clientId });
  if (error) throw new EntitlementsUnavailable(clientId, error.message);
  const rows = (data ?? []) as EntitlementRow[];
  // The catalog always yields a row per service for a visible client: none
  // means the client is not visible to this caller, not "nothing included".
  if (rows.length === 0) throw new EntitlementsUnavailable(clientId, "no entitlement rows (client not visible to this caller)");
  return entitlementSet(clientId, rows);
}

// One service for one client: not included (enabled false, quantity 0 for a
// quota, source none) when the catalog has no such service.
export async function getClientEntitlement(supabase: Reader, clientId: string, key: ServiceKey): Promise<Entitlement> {
  const set = await getClientEntitlements(supabase, clientId);
  return set.byKey[key] ?? {
    key, name: key, kind: isQuotaKey(key) ? "quota" : "feature", enabled: false,
    quantity: isQuotaKey(key) ? 0 : null, unit: null, period: null, source: "none",
  };
}

// Every visible client's set in one read (agency-wide planning, no N+1).
export async function getEntitlementsForClients(supabase: Reader, clientIds?: string[]): Promise<Map<string, EntitlementSet>> {
  const { data, error } = await supabase.rpc("client_entitlements_for", {});
  if (error) throw new EntitlementsUnavailable(null, error.message);
  const rows = (data ?? []) as EntitlementRow[];
  const ids = clientIds ?? [...new Set(rows.map((r) => r.client_id))];
  const out = new Map<string, EntitlementSet>();
  for (const id of ids) {
    const mine = rows.filter((r) => r.client_id === id);
    if (mine.length > 0) out.set(id, entitlementSet(id, mine));
  }
  return out;
}

// This month's (or `month`'s) quota usage for one client, or every visible
// client in one read (clientId null). Throws EntitlementsUnavailable on an
// error: a caller that plans work stops rather than assuming room.
export async function getQuotaUsage(supabase: Reader, clientId: string | null, month?: string): Promise<QuotaUsage[]> {
  const { data, error } = await supabase.rpc("client_quota_usage", {
    ...(clientId ? { p_client_id: clientId } : {}),
    ...(month ? { p_month: month } : {}),
  });
  if (error) throw new EntitlementsUnavailable(clientId, error.message);
  return ((data ?? []) as QuotaUsageRow[]).map(quotaUsage).filter((u): u is QuotaUsage => !!u);
}

export function usageByKey(rows: QuotaUsage[], clientId?: string): Partial<Record<QuotaKey, QuotaUsage>> {
  const out: Partial<Record<QuotaKey, QuotaUsage>> = {};
  for (const u of rows) if (!clientId || u.clientId === clientId) out[u.key] = u;
  return out;
}

// A client's agreement and this month's usage for a screen, failing safe:
// `unavailable` carries the reason when either read fails, and the screen
// says automatic planning is paused rather than assuming anything.
export type ClientAgreement = { set: EntitlementSet | null; usage: QuotaUsage[]; unavailable: string | null };
export async function getClientAgreement(supabase: Reader, clientId: string, month?: string): Promise<ClientAgreement> {
  try {
    const [set, usage] = await Promise.all([getClientEntitlements(supabase, clientId), getQuotaUsage(supabase, clientId, month)]);
    return { set, usage, unavailable: null };
  } catch (e) {
    return { set: null, usage: [], unavailable: e instanceof Error ? e.message : String(e) };
  }
}
