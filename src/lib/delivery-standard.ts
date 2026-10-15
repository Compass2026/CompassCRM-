// The monthly delivery standard (20261015040000): what the team delivers per
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
  remaining: number; over_target: number; standard_version: number; source_ref: string;
};
export type Count = { target: number; completed: number; planned: number; used: number; remaining: number; over: number };
export type DeliveryUnit = { kind: UnitKind; brandId: string | null; name: string; counts: Record<DeliveryKey, Count> };
export type ClientDelivery = {
  clientId: string; month: string; standardVersion: number; sourceRef: string;
  units: DeliveryUnit[];                    // brand sites (or the client), then unattributed
  total: Record<DeliveryKey, Count>;        // the client's month: every unit, counted once
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

const zero = (): Count => ({ target: 0, completed: 0, planned: 0, used: 0, remaining: 0, over: 0 });
const add = (a: Count, r: Pick<DeliveryRow, "target" | "completed" | "planned">): Count => {
  const target = a.target + r.target, completed = a.completed + r.completed, planned = a.planned + r.planned;
  const used = completed + planned;
  return { target, completed, planned, used, remaining: Math.max(0, target - used), over: Math.max(0, used - target) };
};
const blank = () => Object.fromEntries(DELIVERY_KEYS.map((k) => [k, zero()])) as Record<DeliveryKey, Count>;

// Rows → one entry per client. The total adds each unit once: a three-brand
// client's 8 + 8 + 8 is 24, and unattributed work (target 0) is in its used
// count but never in a brand's.
export function groupDelivery(rows: DeliveryRow[]): ClientDelivery[] {
  const out = new Map<string, ClientDelivery>();
  for (const r of rows) {
    if (!(DELIVERY_KEYS as readonly string[]).includes(r.deliverable)) continue;
    let c = out.get(r.client_id);
    if (!c) {
      c = { clientId: r.client_id, month: r.month, standardVersion: r.standard_version, sourceRef: r.source_ref, units: [], total: blank() };
      out.set(r.client_id, c);
    }
    let u = c.units.find((x) => x.kind === r.unit_kind && x.brandId === r.brand_workspace_id);
    if (!u) {
      u = { kind: r.unit_kind, brandId: r.brand_workspace_id, name: r.unit_name, counts: blank() };
      c.units.push(u);
    }
    u.counts[r.deliverable] = add(zero(), r);
    c.total[r.deliverable] = add(c.total[r.deliverable], r);
  }
  for (const c of out.values()) c.units.sort((a, b) => Number(a.kind === "unattributed") - Number(b.kind === "unattributed") || a.name.localeCompare(b.name));
  return [...out.values()];
}

// "3 / 8" — or "3 (no target)" for unattributed work.
export function countText(c: Count): string {
  return c.target > 0 ? `${c.used} / ${c.target}` : `${c.used} (no target)`;
}
// Units that share one client-level Business Profile (a multi-brand client).
export function sharesBusinessProfile(c: ClientDelivery): boolean {
  return c.units.filter((u) => u.kind === "brand").length > 1;
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
