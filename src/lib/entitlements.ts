// The entitlement contract (B5): what Compass has agreed to deliver to a
// client, for every Compass system that plans or shows work. It reads one
// thing — client_entitlements_for() (0061), derived from the agreement's
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
// Pure except for the two loaders, which take a Supabase client.

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

// "4 Blog Posts / month"
export function deliverableText(e: Pick<Entitlement, "name" | "quantity" | "period">): string {
  return `${e.quantity ?? 0} ${e.name}${e.period ? ` / ${e.period}` : ""}`;
}

// ── Loaders (one read per client, or one read for many) ───────────────────
type Reader = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

export async function loadClientEntitlements(supabase: Reader, clientId: string): Promise<EntitlementSet> {
  const { data, error } = await supabase.rpc("client_entitlements_for", { p_client_id: clientId });
  if (error) throw new EntitlementsUnavailable(clientId, error.message);
  const rows = (data ?? []) as EntitlementRow[];
  // The catalog always yields a row per service for a visible client: none
  // means the client is not visible to this caller, not "nothing included".
  if (rows.length === 0) throw new EntitlementsUnavailable(clientId, "no entitlement rows (client not visible to this caller)");
  return entitlementSet(clientId, rows);
}

// Every visible client's set in one read (agency-wide planning, no N+1).
export async function loadEntitlementsForClients(supabase: Reader, clientIds?: string[]): Promise<Map<string, EntitlementSet>> {
  const { data, error } = await supabase.rpc("client_entitlements_for", { p_client_id: null });
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
