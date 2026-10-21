// Server-side reads for the Citations pages and exports. Every read uses the
// teammate's own session, so RLS (team only) applies; client filters are
// explicit as well. Lists are read completely (fetchAll) or not at all: a
// report never shows a partial list as if it were the whole.
import type { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import {
  OPEN_TASK_STATUSES, evidenceFreshness, exportRows, identityCurrent, needsAction, toCsv,
  type CitationListingOverview, type CitationLocation, type CitationTask, type ExportListing,
} from "@/lib/citations";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export const LISTING_VIEWS = {
  all: "All listings",
  action: "Action required",
  discrepancy: "Discrepancies",
  unverified: "Unverified",
  partial: "Partially verified",
  reverify: "Needs reverification",
  inaccessible: "Inaccessible",
  stale: "Not current (stale, superseded or never checked)",
} as const;
export type ListingView = keyof typeof LISTING_VIEWS;
export function listingView(v: string | undefined): ListingView { return v && Object.hasOwn(LISTING_VIEWS, v) ? v as ListingView : "all"; }
export function inView(l: CitationListingOverview, view: ListingView, today?: string) {
  switch (view) {
    case "action": return needsAction(l);
    case "discrepancy": return l.verification_status === "discrepancy";
    case "unverified": return l.verification_status === "unverified";
    case "partial": return l.verification_status === "partially_verified";
    case "reverify": return l.verification_status === "needs_reverification";
    case "inaccessible": return l.verification_status === "inaccessible";
    case "stale": return evidenceFreshness(l.last_checked_on, today, identityCurrent(l)) !== "current";
    default: return true;
  }
}

// Pure, so the unit tests can run it; kept here for the pages' imports.
export { summarize, type LocationSummary } from "@/lib/citations";

export const OVERVIEW_COLUMNS = "id, client_id, location_id, directory_id, listing_url, external_id, listing_key, fulfillment_status, source_name, source_address, source_phone, source_website, source_provider, source_observed_on, last_import_id, last_imported_at, archived, notes, created_at, updated_at, created_by, directory_name, directory_key, location_label, hide_address, identity_version, client_name, last_check_id, last_checked_on, last_check_result, last_check_method, check_identity_version, verification_status, current_name, current_address, current_phone, current_website, open_tasks, suspected_duplicate, check_field_coverage, name_check, address_check, phone_check, website_check";

export async function loadListings(db: Supabase, filter: { clientId?: string; locationId?: string }) {
  const { rows, error } = await fetchAll<CitationListingOverview>((from, to) => {
    let q = db.from("citation_listing_overview").select(OVERVIEW_COLUMNS, { count: "exact" });
    if (filter.clientId) q = q.eq("client_id", filter.clientId);
    if (filter.locationId) q = q.eq("location_id", filter.locationId);
    return q.order("directory_name").order("listing_key").order("id").range(from, to) as unknown as PromiseLike<{ data: CitationListingOverview[] | null; error: unknown; count: number | null }>;
  });
  return { listings: rows, error: error ? `Listings: ${error}` : null };
}

export async function loadOpenTasks(db: Supabase, filter: { clientId?: string; locationId?: string }) {
  const { rows, error } = await fetchAll<CitationTask>((from, to) => {
    let q = db.from("citation_tasks").select("*", { count: "exact" }).in("status", OPEN_TASK_STATUSES);
    if (filter.clientId) q = q.eq("client_id", filter.clientId);
    if (filter.locationId) q = q.eq("location_id", filter.locationId);
    return q.order("id").range(from, to);
  });
  return { tasks: rows, error: error ? `Tasks: ${error}` : null };
}

/** CSV for a client (optionally one location), from the overview projection. Client-safe unless the internal variant is asked for. */
export async function exportCsv(db: Supabase, clientId: string, variant: "client" | "internal", locationId?: string, view: ListingView = "all") {
  const [locs, { listings, error }] = await Promise.all([
    fetchAll<CitationLocation>((from, to) => db.from("citation_locations").select("*", { count: "exact" }).eq("client_id", clientId).order("id").range(from, to)),
    loadListings(db, { clientId, locationId }),
  ]);
  if (locs.error || error) return null;
  const byId = new Map(locs.rows.map((l) => [l.id, l]));
  const rows: ExportListing[] = listings.filter((l) => inView(l, view) && byId.has(l.location_id)).map((l) => ({ ...l, identity: byId.get(l.location_id)! }));
  return toCsv(exportRows(rows, variant));
}
