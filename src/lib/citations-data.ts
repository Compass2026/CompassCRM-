// Server-side reads for the Citations pages and exports. Every read uses the
// teammate's own session, so RLS (team only) applies; client filters are
// explicit as well.
import type { createClient } from "@/lib/supabase/server";
import {
  OPEN_TASK_STATUSES, evidenceFreshness, exportRows, needsAction, toCsv,
  type CitationListingOverview, type CitationLocation, type ExportListing, type VerificationStatus,
} from "@/lib/citations";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export const LISTING_VIEWS = {
  all: "All listings",
  action: "Action required",
  discrepancy: "Discrepancies",
  unverified: "Unverified",
  inaccessible: "Inaccessible",
  stale: "Stale or never checked",
} as const;
export type ListingView = keyof typeof LISTING_VIEWS;
export function listingView(v: string | undefined): ListingView { return v && Object.hasOwn(LISTING_VIEWS, v) ? v as ListingView : "all"; }
export function inView(l: CitationListingOverview, view: ListingView, today?: string) {
  switch (view) {
    case "action": return needsAction(l);
    case "discrepancy": return l.verification_status === "discrepancy";
    case "unverified": return l.verification_status === "unverified";
    case "inaccessible": return l.verification_status === "inaccessible";
    case "stale": return evidenceFreshness(l.last_checked_on, today) !== "current";
    default: return true;
  }
}

export type LocationSummary = {
  total: number; byVerification: Record<VerificationStatus, number>; providerCompleteUnverified: number; openTasks: number;
  stale: number; never: number; duplicates: number; action: number; lastImport: string | null;
};
export function summarize(listings: CitationListingOverview[], openTasks: number, today?: string): LocationSummary {
  const byVerification = { unverified: 0, verified_accurate: 0, discrepancy: 0, inaccessible: 0, confirmed_absent: 0 };
  let providerCompleteUnverified = 0, stale = 0, never = 0, duplicates = 0, action = 0, lastImport: string | null = null;
  for (const l of listings) {
    byVerification[l.verification_status]++;
    if (l.fulfillment_status === "provider_complete" && l.verification_status === "unverified") providerCompleteUnverified++;
    const f = evidenceFreshness(l.last_checked_on, today);
    if (f === "stale") stale++; else if (f === "none") never++;
    if (l.suspected_duplicate) duplicates++;
    if (needsAction(l)) action++;
    if (l.last_imported_at && (!lastImport || l.last_imported_at > lastImport)) lastImport = l.last_imported_at;
  }
  return { total: listings.length, byVerification, providerCompleteUnverified, openTasks, stale, never, duplicates, action, lastImport };
}

const OVERVIEW_COLUMNS = "id, client_id, location_id, directory_id, listing_url, external_id, listing_key, fulfillment_status, verification_status, observed_name, observed_address, observed_phone, observed_website, source_provider, source_observed_on, last_import_id, last_imported_at, last_checked_on, last_check_id, archived, notes, created_at, updated_at, created_by, directory_name, directory_key, location_label, hide_address, client_name, open_tasks, suspected_duplicate";
const LIMIT = 5000;

export async function loadListings(db: Supabase, filter: { clientId?: string; locationId?: string }) {
  let q = db.from("citation_listing_overview").select(OVERVIEW_COLUMNS);
  if (filter.clientId) q = q.eq("client_id", filter.clientId);
  if (filter.locationId) q = q.eq("location_id", filter.locationId);
  const { data, error } = await q.order("directory_name").order("listing_key").limit(LIMIT);
  if (error) return { listings: [] as CitationListingOverview[], error: "Listings could not be read. Refresh to retry." };
  if ((data ?? []).length === LIMIT) return { listings: data as CitationListingOverview[], error: `Showing the first ${LIMIT} listings only. Narrow the view.` };
  return { listings: (data ?? []) as CitationListingOverview[], error: null };
}

export async function loadOpenTasks(db: Supabase, filter: { clientId?: string; locationId?: string }) {
  let q = db.from("citation_tasks").select("*").in("status", OPEN_TASK_STATUSES);
  if (filter.clientId) q = q.eq("client_id", filter.clientId);
  if (filter.locationId) q = q.eq("location_id", filter.locationId);
  return q.order("due_on", { ascending: true, nullsFirst: false }).limit(1000);
}

/** CSV for a client (optionally one location). Client-safe unless the internal variant is asked for. */
export async function exportCsv(db: Supabase, clientId: string, variant: "client" | "internal", locationId?: string, view: ListingView = "all") {
  const [{ data: locs, error: le }, { listings, error }] = await Promise.all([
    db.from("citation_locations").select("*").eq("client_id", clientId),
    loadListings(db, { clientId, locationId }),
  ]);
  if (le || error) return null;
  const byId = new Map((locs as CitationLocation[]).map((l) => [l.id, l]));
  const rows: ExportListing[] = listings.filter((l) => inView(l, view) && byId.has(l.location_id)).map((l) => ({
    ...l, client_name: l.client_name, location_label: l.location_label, identity: byId.get(l.location_id)!, directory_name: l.directory_name,
  }));
  return toCsv(exportRows(rows, variant));
}
