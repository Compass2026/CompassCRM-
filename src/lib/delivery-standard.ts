// The monthly delivery standard (20261015150000): what the team delivers per
// brand site (or client) each America/Chicago calendar month, read from
// delivery_targets(). Operational only — the agreement's entitlements
// (entitlements.ts) stay what billing, agreements and the portal read.
// Relative imports (not "@/"), so the unit tests load this file in Node.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.ts";
import { AGENCY_TIME_ZONE, todayIn } from "./tasks.ts";

export const DELIVERY_KEYS = ["blog_posts", "facebook_posts", "gbp_posts", "page_refreshes"] as const;
export type DeliveryKey = (typeof DELIVERY_KEYS)[number];
export const deliveryLabels: Record<DeliveryKey, string> = {
  blog_posts: "Blogs",
  facebook_posts: "Facebook posts",
  gbp_posts: "Business Profile posts",
  page_refreshes: "Page refreshes",
};
export type UnitKind = "client" | "brand" | "unattributed";

export type DeliveryRow = {
  client_id: string; month: string; unit_kind: UnitKind; brand_workspace_id: string | null; unit_name: string;
  deliverable: DeliveryKey; target: number; completed: number; planned: number; used: number;
  remaining: number; over_target: number; unverified: number; destination: string | null;
  standard_version: number; source_ref: string;
};
// credited: delivered work within the target (never more than the target);
// remaining: the target's room not yet planned or delivered;
// unverified: refreshes approved without a live receipt (not credited).
export type Count = { target: number; completed: number; planned: number; used: number; remaining: number; over: number; credited: number; unverified: number };
export type DeliveryUnit = {
  kind: UnitKind; brandId: string | null; name: string; counts: Record<DeliveryKey, Count>;
  destinations: Partial<Record<DeliveryKey, string | null>>;
};
export type ClientDelivery = {
  clientId: string; month: string; standardVersion: number; sourceRef: string;
  units: DeliveryUnit[];                    // brand sites (or the client), then unattributed
  // The entitled sites only: target and remaining are each site's own,
  // summed, so one site's surplus never covers another's shortfall.
  total: Record<DeliveryKey, Count>;
  // Work with no brand: shown, never credited.
  unattributed: Record<DeliveryKey, Count>;
};

const ISO_MONTH = /^(\d{4})-(\d{2})(?:-\d{2})?$/;

// yyyy-mm-01 of the America/Chicago month containing `now`.
export function currentMonth(now: Date = new Date()): string {
  return `${todayIn(AGENCY_TIME_ZONE, now).slice(0, 7)}-01`;
}
// A ?month= parameter (yyyy-mm or any yyyy-mm-dd) → yyyy-mm-01; anything else → the current month.
export function parseMonth(v: unknown, now: Date = new Date()): string {
  const m = typeof v === "string" ? v.match(ISO_MONTH) : null;
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return currentMonth(now);
  return `${m[1]}-${m[2]}-01`;
}
// The month a yyyy-mm-dd date (a planner week's Monday) falls in.
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

const zero = (): Count => ({ target: 0, completed: 0, planned: 0, used: 0, remaining: 0, over: 0, credited: 0, unverified: 0 });
const blank = () => Object.fromEntries(DELIVERY_KEYS.map((k) => [k, zero()])) as Record<DeliveryKey, Count>;
const unitCount = (r: DeliveryRow): Count => {
  const used = r.completed + r.planned;
  return {
    target: r.target, completed: r.completed, planned: r.planned, used,
    remaining: Math.max(0, r.target - used), over: Math.max(0, used - r.target),
    credited: Math.min(r.completed, r.target), unverified: r.unverified ?? 0,
  };
};
const sum = (a: Count, b: Count): Count => ({
  target: a.target + b.target, completed: a.completed + b.completed, planned: a.planned + b.planned, used: a.used + b.used,
  remaining: a.remaining + b.remaining, over: a.over + b.over, credited: a.credited + b.credited, unverified: a.unverified + b.unverified,
});

// Rows → one entry per client. Totals add each entitled site's own numbers:
// a three-brand client's target is 8 + 8 + 8 = 24 and its remaining is the
// sum of each brand's shortfall, so a brand over its target does not hide a
// brand under it. Unattributed work stays in its own bucket.
export function groupDelivery(rows: DeliveryRow[]): ClientDelivery[] {
  const out = new Map<string, ClientDelivery>();
  for (const r of rows) {
    if (!(DELIVERY_KEYS as readonly string[]).includes(r.deliverable)) continue;
    let c = out.get(r.client_id);
    if (!c) {
      c = { clientId: r.client_id, month: r.month, standardVersion: r.standard_version, sourceRef: r.source_ref, units: [], total: blank(), unattributed: blank() };
      out.set(r.client_id, c);
    }
    let u = c.units.find((x) => x.kind === r.unit_kind && x.brandId === r.brand_workspace_id);
    if (!u) {
      u = { kind: r.unit_kind, brandId: r.brand_workspace_id, name: r.unit_name, counts: blank(), destinations: {} };
      c.units.push(u);
    }
    const count = unitCount(r);
    u.counts[r.deliverable] = count;
    u.destinations[r.deliverable] = r.destination ?? null;
    if (r.unit_kind === "unattributed") c.unattributed[r.deliverable] = sum(c.unattributed[r.deliverable], { ...count, credited: 0, remaining: 0, over: 0 });
    else c.total[r.deliverable] = sum(c.total[r.deliverable], count);
  }
  for (const c of out.values()) c.units.sort((a, b) => Number(a.kind === "unattributed") - Number(b.kind === "unattributed") || a.name.localeCompare(b.name));
  return [...out.values()];
}

// "3 / 8" for a site (done + planned against its target); a total reads
// delivered work credited site by site against the summed targets.
export function countText(c: Count): string {
  return c.target > 0 ? `${c.used} / ${c.target}` : `${c.used} (no target)`;
}
export function totalText(c: Count): string {
  return `${c.credited} / ${c.target} delivered${c.planned > 0 ? ` · ${c.planned} planned` : ""}${c.remaining > 0 ? ` · ${c.remaining} not yet planned` : ""}${c.over > 0 ? ` · ${c.over} beyond a site's target` : ""}`;
}
// The Business Profile location every site posts to, only when one verified
// location is recorded for the client (delivery_targets' destination); null
// otherwise. Having several brands is not evidence of a shared profile.
export function sharedBusinessProfile(c: ClientDelivery): string | null {
  const sites = c.units.filter((u) => u.kind !== "unattributed");
  const dests = new Set(sites.map((u) => u.destinations.gbp_posts ?? null));
  if (dests.size !== 1) return null;
  return [...dests][0];
}
// Monthly room left per planner slot kind, summed over the entitled sites.
export function remainingFor(c: ClientDelivery | null | undefined, key: DeliveryKey): number {
  return c ? c.total[key].remaining : 0;
}

type Reader = SupabaseClient<Database>;
// One client (or every visible client) for a month. Null data or an error is
// reported, never treated as "no standard".
export async function getDeliveryTargets(supabase: Reader, clientId: string | null, month: string):
  Promise<{ clients: ClientDelivery[]; error: string | null }> {
  const { data, error } = await supabase.rpc("delivery_targets", { ...(clientId ? { p_client_id: clientId } : {}), p_month: month });
  if (error) return { clients: [], error: error.message };
  return { clients: groupDelivery((data ?? []) as DeliveryRow[]), error: null };
}
