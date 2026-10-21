"use server";
// Citations Phase 1 server actions. A server action is a public endpoint, so
// each one checks the deployment flag and the team itself, scopes every write
// to the client in the URL, and lets the database guards have the last word.
// Nothing here contacts a provider or a directory.
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/database.types";
import { getCurrentTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { agencyToday, validDate } from "@/lib/reporting";
import { citationsEnabled } from "@/lib/citations-flag";
import { GENERIC_MAPPING, prepareBrightLocalCampaign } from "@/lib/citations-brightlocal";
import { loadListings } from "@/lib/citations-data";
import {
  CHECK_FIELDS, CHECK_METHODS, FIELD_STATUSES, FULFILLMENT_STATUSES, IMPORT_MAX_BYTES, REQUEST_ACTIONS, REQUEST_STATUSES, RESULT_METHODS, TASK_KINDS, TASK_STATUSES,
  citationText, coverageText, deriveCheckResult, fieldChecks, isCredentialHeader, listingKey, listingUrl, parseCsv, prepareImport, storedFileName, storedLocationMapping,
  type CheckMethod, type CheckResult, type ColumnMapping, type FieldStatus, type FieldStatuses, type ImportField, type LocationMapping,
} from "@/lib/citations";

export type CitationActionState = { error?: string; savedId?: string };
/** An enrichment whose URL / id is already on listings elsewhere waits for the teammate to review them. */
export type EnrichmentState = CitationActionState & { matches?: { id: string; label: string }[] };

const PROVIDER = /^[a-z][a-z0-9_]{1,39}$/;

async function team(clientId: string) {
  if (!citationsEnabled()) throw new Error("Citations are switched off in this deployment.");
  if (!isUuid(clientId)) throw new Error("Invalid client. Refresh and try again.");
  const db = await createClient();
  if (!(await getCurrentTeamMember(db))) throw new Error("Only Compass team members can manage citations.");
  const { data: client } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) throw new Error("Client unavailable.");
  return db;
}
function uuid(v: string) { if (!isUuid(v)) throw new Error("Invalid record identifier. Refresh and try again."); return v; }
function refresh(clientId: string, locationId?: string) {
  revalidatePath("/citations");
  revalidatePath(`/clients/${clientId}/citations`);
  if (locationId) revalidatePath(`/clients/${clientId}/citations/${locationId}`);
}
// Guard messages (23514 / 42501 / 23505 from the triggers and constraints) are written for people.
function dbError(e: { code?: string; message: string } | null, fallback: string) {
  if (!e) return;
  if (e.code === "23505") throw new Error("That record already exists. Refresh to see it.");
  throw new Error(e.code === "23514" || e.code === "42501" ? e.message : fallback);
}
function failure(e: unknown): CitationActionState { return { error: e instanceof Error ? e.message : "Unable to save. Try again." }; }
function optionalDate(form: FormData, key: string, label: string) {
  const v = citationText(form, key, 10);
  if (v && !validDate(v)) throw new Error(`Choose a valid ${label}.`);
  return v || null;
}
function money(form: FormData, key: string) {
  const v = citationText(form, key, 20);
  if (!v) return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) throw new Error(`Enter ${key.replaceAll("_", " ")} as an amount like 3.20.`);
  return Number(v);
}
function currency(form: FormData, key: string) {
  const v = (citationText(form, key, 3) || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(v)) throw new Error("Use a three-letter currency code.");
  return v;
}

// ── Locations ──────────────────────────────────────────────────────────────

function identity(form: FormData) {
  const website = citationText(form, "website_url", 2000);
  return {
    label: citationText(form, "label", 120),
    business_name: citationText(form, "business_name", 200),
    address_line1: citationText(form, "address_line1", 200),
    address_line2: citationText(form, "address_line2", 200),
    city: citationText(form, "city", 100),
    region: citationText(form, "region", 50),
    postal_code: citationText(form, "postal_code", 20),
    phone: citationText(form, "phone", 40),
    website_url: website ? listingUrl(website) : null,
    hide_address: form.get("hide_address") === "on",
    tracking_location_id: citationText(form, "tracking_location_id", 36) ? uuid(citationText(form, "tracking_location_id", 36)) : null,
    brand_workspace_id: citationText(form, "brand_workspace_id", 36) ? uuid(citationText(form, "brand_workspace_id", 36)) : null,
    notes: citationText(form, "notes", 2000),
  };
}

export async function createCitationLocationAction(clientId: string, _s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    const db = await team(clientId);
    const id = uuid(citationText(form, "id", 36));
    const row = { id, client_id: clientId, ...identity(form), identity_note: "Initial approved identity" };
    if (!row.label || !row.business_name) throw new Error("Enter a location label and the approved business name.");
    const { error } = await db.from("citation_locations").insert(row);
    if (error?.code === "23505") {
      const { data } = await db.from("citation_locations").select("id").eq("client_id", clientId).eq("id", id).maybeSingle();
      if (!data) throw new Error("A location with that label already exists for this client.");
    } else dbError(error, "The location could not be saved. Your entry is kept for retry.");
    refresh(clientId, id);
    return { savedId: id };
  } catch (e) { return failure(e); }
}

export async function updateCitationLocationAction(clientId: string, locationId: string, _s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    const db = await team(clientId); uuid(locationId);
    const status = citationText(form, "status", 10) || "active";
    if (!["active", "archived"].includes(status)) throw new Error("Choose a status.");
    const { data, error } = await db.from("citation_locations")
      .update({ ...identity(form), status: status as "active" | "archived", identity_note: citationText(form, "identity_note", 1000) })
      .eq("client_id", clientId).eq("id", locationId).eq("updated_at", citationText(form, "updated_at", 50)).select("id").maybeSingle();
    dbError(error, "The location could not be updated. Your entry is kept for retry.");
    if (!data) throw new Error("This location changed or is unavailable. Refresh before editing it.");
    refresh(clientId, locationId);
    return { savedId: locationId };
  } catch (e) { return failure(e); }
}

// ── Directories and listings ──────────────────────────────────────────────

export async function addCitationDirectoryAction(clientId: string, _s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    const db = await team(clientId);
    const name = citationText(form, "name", 120);
    const domain = citationText(form, "domain", 200).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (!name) throw new Error("Enter the directory name.");
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error("Enter the directory's domain like example.com, or leave it blank.");
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
    if (key.length < 2) throw new Error("Use a longer directory name.");
    const { data, error } = await db.from("citation_directories").insert({ key, name, domain: domain || null, kind: "other" }).select("id").maybeSingle();
    dbError(error, "The directory could not be added.");
    refresh(clientId);
    return { savedId: data?.id };
  } catch (e) { return failure(e); }
}

export async function addCitationListingAction(clientId: string, locationId: string, _s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    const db = await team(clientId); uuid(locationId);
    const id = uuid(citationText(form, "id", 36));
    const fulfillment = citationText(form, "fulfillment_status", 30) || "none";
    if (!Object.hasOwn(FULFILLMENT_STATUSES, fulfillment)) throw new Error("Choose a provider status.");
    const url = citationText(form, "listing_url", 2000);
    const row = {
      id, client_id: clientId, location_id: locationId, directory_id: uuid(citationText(form, "directory_id", 36)),
      listing_url: url ? listingUrl(url) : null, external_id: citationText(form, "external_id", 200) || null,
      fulfillment_status: fulfillment as keyof typeof FULFILLMENT_STATUSES, source_provider: "manual_entry", notes: citationText(form, "notes", 2000),
    };
    const { error } = await db.from("citation_listings").insert(row);
    if (error?.code === "23505") {
      const { data } = await db.from("citation_listings").select("id").eq("client_id", clientId).eq("id", id).maybeSingle();
      if (!data) throw new Error("This location already has that listing for this directory. Open the existing record.");
    } else dbError(error, "The listing could not be saved. Your entry is kept for retry.");
    refresh(clientId, locationId);
    return { savedId: id };
  } catch (e) { return failure(e); }
}

const OBSERVED_MAX: Record<(typeof CHECK_FIELDS)[number], number> = { name: 300, address: 500, phone: 50, website: 2000 };
const REVIEWS = ["content", "inaccessible", "not_found", "confirmed_absent"] as const;

/**
 * A check is either a review of the listing's content, field by field, or a
 * listing-level outcome that observes nothing (inaccessible, not found,
 * confirmed absent). For a content review each field is verified, a
 * discrepancy, not displayed, not checked or could not be viewed, with the
 * value as shown kept exactly when the field was seen. The result follows from
 * the fields (the database derives it the same way): a name-only review is
 * partial, never "verified accurate".
 */
export async function recordCitationCheckAction(clientId: string, listingId: string, _s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    const db = await team(clientId); uuid(listingId);
    const { data: listing } = await db.from("citation_listings").select("id, location_id").eq("client_id", clientId).eq("id", listingId).maybeSingle();
    if (!listing) throw new Error("Listing unavailable for this client.");
    const { data: loc } = await db.from("citation_locations").select("hide_address, phone, website_url").eq("client_id", clientId).eq("id", listing.location_id).maybeSingle();
    if (!loc) throw new Error("Location unavailable for this client.");
    const checked_on = citationText(form, "checked_on", 10), method = citationText(form, "method", 30), review = citationText(form, "review", 30) || "content";
    if (!validDate(checked_on) || checked_on > agencyToday()) throw new Error("Choose a check date ending today or earlier.");
    if (!(REVIEWS as readonly string[]).includes(review) || !Object.hasOwn(CHECK_METHODS, method)) throw new Error("Choose how you checked and what you found.");
    const observed = { observed_name: "", observed_address: "", observed_phone: "", observed_website: "" };
    const statuses: Record<(typeof CHECK_FIELDS)[number], FieldStatus | null> = { name: null, address: null, phone: null, website: null };
    let result: CheckResult;
    if (review === "content") {
      for (const f of CHECK_FIELDS) {
        const status = citationText(form, `${f}_status`, 20);
        if (!Object.hasOwn(FIELD_STATUSES, status)) throw new Error(`Choose what you found for the ${f}.`);
        const value = citationText(form, `observed_${f}`, OBSERVED_MAX[f]);
        const seen = status === "verified" || status === "discrepancy";
        if (seen && !value) throw new Error(`Record the ${f} exactly as the listing shows it: a verified or differing field keeps the value you saw.`);
        if (!seen && value) throw new Error(`Clear the ${f} you typed, or mark it verified or a discrepancy: a value is kept only for a field you saw.`);
        statuses[f] = status as FieldStatus;
        observed[`observed_${f}`] = value;
      }
      result = deriveCheckResult(statuses as FieldStatuses, loc);
    } else result = review as CheckResult;
    if (!RESULT_METHODS[result].includes(method as CheckMethod))
      throw new Error(result === "confirmed_absent" ? "Absence needs the publisher's confirmation or the owner dashboard; a search that finds nothing is \"not found\"."
        : "That method cannot support that result. Choose how you actually checked.");
    const evidence = citationText(form, "evidence", 2000);
    if (!evidence) throw new Error("Record the evidence: what you saw and where (screenshot or reference).");
    const evidenceUrl = citationText(form, "evidence_url", 2000);
    const id = uuid(citationText(form, "id", 36));
    const row = { id, listing_id: listingId, checked_on, method: method as CheckMethod, result, evidence, evidence_url: evidenceUrl ? listingUrl(evidenceUrl) : null, ...observed,
      name_status: statuses.name, address_status: statuses.address, phone_status: statuses.phone, website_status: statuses.website };
    const { error } = await db.from("citation_checks").insert(row);
    if (error?.code === "23505") {
      const { data } = await db.from("citation_checks").select("id").eq("id", id).eq("listing_id", listingId).maybeSingle();
      if (!data) throw new Error("This check was already saved with different data. Start a new check.");
    } else dbError(error, "The check could not be saved. Your entry is kept for retry.");
    refresh(clientId, listing.location_id);
    return { savedId: id };
  } catch (e) { return failure(e); }
}

/**
 * Adds a public URL and / or an external id to an existing listing that lacks
 * them, as an append-only enrichment record (before, after, reason, who, when).
 * The listing keeps its id, import provenance, provider status, checks and
 * tasks; its earlier key stays on record, so reimporting the original or the
 * enriched source finds the same listing. Uses the import's normalization:
 * - another listing of this directory at this location already carrying the
 *   URL / id is refused: that is a suspected duplicate to resolve, not merge;
 * - listings elsewhere (another location, directory or client) carrying it are
 *   shown and must be reviewed before the enrichment is saved.
 * Credentials and tokenized verification links are refused (citationText).
 */
export async function enrichCitationListingAction(clientId: string, listingId: string, _s: EnrichmentState, form: FormData): Promise<EnrichmentState> {
  try {
    const db = await team(clientId); uuid(listingId);
    const id = uuid(citationText(form, "id", 36));
    const { data: saved } = await db.from("citation_listing_enrichments").select("id").eq("client_id", clientId).eq("id", id).maybeSingle();
    if (saved) return { savedId: id };
    const { data: listing } = await db.from("citation_listings").select("id, location_id, directory_id, listing_url, external_id, archived")
      .eq("client_id", clientId).eq("id", listingId).maybeSingle();
    if (!listing || listing.archived) throw new Error("Listing unavailable for this client.");
    const rawUrl = citationText(form, "listing_url", 2000), ext = citationText(form, "external_id", 200), reason = citationText(form, "reason", 1000);
    if (!rawUrl && !ext) throw new Error("Add the listing URL, the external id, or both.");
    if (rawUrl && listing.listing_url) throw new Error("This listing already has a URL. A different URL is a different listing: add it separately and resolve the suspected duplicate.");
    if (ext && listing.external_id) throw new Error("This listing already has an external id, which is fixed.");
    if (!reason) throw new Error("Say where you found the URL / id (the evidence) before saving.");
    const url = rawUrl ? listingUrl(rawUrl) : null;
    const afterExt = ext || listing.external_id;
    const keys = [...new Set([listingKey(url ?? listing.listing_url, afterExt), ...(afterExt ? [listingKey(null, afterExt)] : [])])];
    const { data: owners, error: ownersError } = await db.from("citation_listing_keys").select("listing_id, location_id, directory_id").in("listing_key", keys).neq("listing_id", listingId);
    if (ownersError) throw new Error("Existing listings could not be checked for this URL / id. Retry.");
    if ((owners ?? []).some((o) => o.location_id === listing.location_id && o.directory_id === listing.directory_id))
      throw new Error("That URL or id already identifies another listing of this directory at this location. Open a \"Resolve suspected duplicate\" task for the two listings instead of enriching.");
    const elsewhere = [...new Set((owners ?? []).map((o) => o.listing_id))];
    const acknowledged = new Set(form.getAll("acknowledge").filter((v): v is string => typeof v === "string"));
    if (elsewhere.some((o) => !acknowledged.has(o))) {
      const { data: others } = await db.from("citation_listing_overview").select("id, client_name, location_label, directory_name, listing_url, external_id").in("id", elsewhere);
      return { error: "This URL or id is already on another listing. Review it below and confirm before saving.",
        matches: elsewhere.map((o) => { const x = others?.find((r) => r.id === o); return { id: o, label: x ? `${x.client_name} · ${x.location_label} · ${x.directory_name}${x.listing_url ? ` · ${x.listing_url}` : x.external_id ? ` · id ${x.external_id}` : ""}` : "An archived listing" }; }) };
    }
    const { error } = await db.from("citation_listing_enrichments").insert({ id, client_id: clientId, listing_id: listingId, listing_url: url, external_id: ext || null, reason,
      acknowledged_listing_ids: elsewhere });
    if (error?.code === "23505") {
      const { data } = await db.from("citation_listing_enrichments").select("id").eq("client_id", clientId).eq("id", id).maybeSingle();
      if (!data) throw new Error("This listing changed. Refresh before adding its URL / id.");
    } else dbError(error, "The URL / id could not be saved. Your entry is kept for retry.");
    refresh(clientId, listing.location_id);
    return { savedId: id };
  } catch (e) { return failure(e); }
}

// ── Tasks ─────────────────────────────────────────────────────────────────

export async function openCitationTaskAction(clientId: string, locationId: string, _s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    const db = await team(clientId); uuid(locationId);
    const kind = citationText(form, "kind", 30), reason = citationText(form, "reason", 2000);
    if (!Object.hasOwn(TASK_KINDS, kind) || !reason) throw new Error("Choose the task type and say why it is needed.");
    const listing = citationText(form, "listing_id", 36), assignee = citationText(form, "assignee_id", 36);
    const id = uuid(citationText(form, "id", 36));
    const { error } = await db.from("citation_tasks").insert({ id, client_id: clientId, location_id: locationId, listing_id: listing ? uuid(listing) : null,
      kind: kind as keyof typeof TASK_KINDS, reason, assignee_id: assignee ? uuid(assignee) : null, due_on: optionalDate(form, "due_on", "due date") });
    if (error?.code === "23505") {
      const { data } = await db.from("citation_tasks").select("id").eq("client_id", clientId).eq("id", id).maybeSingle();
      if (!data) throw new Error("This listing already has an open task of that type.");
    } else dbError(error, "The task could not be opened. Your entry is kept for retry.");
    refresh(clientId, locationId);
    return { savedId: id };
  } catch (e) { return failure(e); }
}

export async function updateCitationTaskAction(clientId: string, taskId: string, _s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    const db = await team(clientId); uuid(taskId);
    const status = citationText(form, "status", 20);
    if (!Object.hasOwn(TASK_STATUSES, status)) throw new Error("Choose a status.");
    const assignee = citationText(form, "assignee_id", 36), check = citationText(form, "check_id", 36);
    const closing = status === "resolved" || status === "cancelled";
    const resolution = citationText(form, "resolution", 2000), evidence = citationText(form, "evidence_ref", 2000);
    if (closing && !resolution) throw new Error("Describe the resolution before closing the task.");
    if (status === "resolved" && !evidence && !check) throw new Error("Link the check that proves it, or give an evidence reference.");
    const resolvedOn = status === "resolved" ? optionalDate(form, "resolved_on", "resolution date") : null;
    if (status === "resolved" && !resolvedOn) throw new Error("Enter the date the fix was confirmed.");
    const { data, error } = await db.from("citation_tasks").update({
      status: status as keyof typeof TASK_STATUSES, assignee_id: assignee ? uuid(assignee) : null, due_on: optionalDate(form, "due_on", "due date"),
      resolution: closing ? resolution : "", resolved_on: resolvedOn, evidence_ref: evidence, check_id: closing && check ? uuid(check) : null,
    }).eq("client_id", clientId).eq("id", taskId).eq("updated_at", citationText(form, "updated_at", 50)).select("id, location_id").maybeSingle();
    dbError(error, "The task could not be updated. Your entry is kept for retry.");
    if (!data) throw new Error("This task changed or is unavailable. Refresh before updating it.");
    refresh(clientId, data.location_id);
    return { savedId: taskId };
  } catch (e) { return failure(e); }
}

/**
 * One verify task for every listing with a URL that is not currently verified
 * (unverified, needs reverification, or partially verified with fields not yet
 * checked) and has no open verify task. A listing
 * without a URL needs an investigation first, which a person opens. Safe to
 * repeat: the one-open-task index makes a second run add nothing.
 */
export async function queueVerificationAction(clientId: string, locationId: string): Promise<CitationActionState & { created?: number }> {
  try {
    const db = await team(clientId); uuid(locationId);
    const { data: loc } = await db.from("citation_locations").select("identity_version, hide_address").eq("client_id", clientId).eq("id", locationId).maybeSingle();
    if (!loc) throw new Error("Location unavailable for this client.");
    const { listings, error } = await loadListings(db, { clientId, locationId });
    if (error) throw new Error(error);
    const { data: open } = await db.from("citation_tasks").select("listing_id").eq("location_id", locationId).eq("kind", "verify").in("status", ["open", "in_progress", "waiting"]);
    const busy = new Set((open ?? []).map((t) => t.listing_id));
    const unchecked = (l: (typeof listings)[number]) => Object.entries(fieldChecks(l)).filter(([, v]) => v === "not_checked").map(([f]) => f);
    const due = listings.filter((l) => l.listing_url && !busy.has(l.id)
      && (["unverified", "needs_reverification"].includes(l.verification_status) || (l.verification_status === "partially_verified" && unchecked(l).length > 0)));
    let created = 0;
    const hidden = loc.hide_address ? ". Hidden-address business: if the listing shows a street address, record that as a discrepancy; never add the street" : "";
    for (const l of due) {
      const reason = l.verification_status === "partially_verified"
        ? `Finish verifying ${l.directory_name} against approved identity v${loc.identity_version}: the ${l.last_checked_on} check covered ${coverageText(l)}. Open the listing URL and record ${unchecked(l).join(", ")}${hidden}.`
        : `Verify ${l.directory_name} against approved identity v${loc.identity_version}: open the listing URL and record name, phone, website and address`
          + `${hidden}. Provider status: ${l.fulfillment_status.replace("_", " ")}; never independently checked`
          + `${l.verification_status === "needs_reverification" ? " against the current identity" : ""}.`;
      const { error: e } = await db.from("citation_tasks").insert({ client_id: clientId, location_id: locationId, listing_id: l.id, kind: "verify", reason });
      if (!e) created++;
      else if (e.code !== "23505") throw new Error("Some verification tasks could not be opened. Retry; the ones already opened are kept.");
    }
    refresh(clientId, locationId);
    return { savedId: locationId, created };
  } catch (e) { return failure(e); }
}

// ── Manual fulfillment and credits (records only; nothing is ordered) ─────

export async function createCitationRequestAction(clientId: string, locationId: string, _s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    const db = await team(clientId); uuid(locationId);
    const action = citationText(form, "action", 30), provider = citationText(form, "provider", 40), status = citationText(form, "status", 30) || "draft";
    if (!Object.hasOwn(REQUEST_ACTIONS, action) || !PROVIDER.test(provider)) throw new Error("Choose the action and the provider.");
    if (!["draft", "pending_approval"].includes(status)) throw new Error("A request starts as a draft or pending approval.");
    const listing = citationText(form, "listing_id", 36), id = uuid(citationText(form, "id", 36));
    const { error } = await db.from("citation_fulfillment_requests").insert({ id, client_id: clientId, location_id: locationId,
      directory_id: uuid(citationText(form, "directory_id", 36)), listing_id: listing ? uuid(listing) : null,
      action: action as keyof typeof REQUEST_ACTIONS, provider, status: status as "draft" | "pending_approval",
      approved_budget: money(form, "approved_budget"), budget_currency: currency(form, "budget_currency"), notes: citationText(form, "notes", 2000) });
    if (error?.code === "23505") {
      const { data } = await db.from("citation_fulfillment_requests").select("id").eq("client_id", clientId).eq("id", id).maybeSingle();
      if (!data) throw new Error("This request was already saved with different data.");
    } else dbError(error, "The request could not be saved. Your entry is kept for retry.");
    refresh(clientId, locationId);
    return { savedId: id };
  } catch (e) { return failure(e); }
}

export async function updateCitationRequestAction(clientId: string, requestId: string, _s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    const db = await team(clientId); uuid(requestId);
    const status = citationText(form, "status", 30);
    if (!Object.hasOwn(REQUEST_STATUSES, status)) throw new Error("Choose a status.");
    const credits = citationText(form, "credits_used", 6);
    if (credits && !/^\d{1,6}$/.test(credits)) throw new Error("Credits used must be a whole number.");
    const { data, error } = await db.from("citation_fulfillment_requests").update({
      status: status as keyof typeof REQUEST_STATUSES, provider_reference: citationText(form, "provider_reference", 300),
      approved_budget: money(form, "approved_budget"), budget_currency: currency(form, "budget_currency"),
      actual_amount: money(form, "actual_amount"), actual_currency: currency(form, "actual_currency"),
      credits_used: credits ? Number(credits) : null, notes: citationText(form, "notes", 2000),
    }).eq("client_id", clientId).eq("id", requestId).eq("updated_at", citationText(form, "updated_at", 50)).select("id, location_id").maybeSingle();
    dbError(error, "The request could not be updated. Your entry is kept for retry.");
    if (!data) throw new Error("This request changed or is unavailable. Refresh before updating it.");
    refresh(clientId, data.location_id);
    return { savedId: requestId };
  } catch (e) { return failure(e); }
}

export async function recordCreditEntryAction(_s: CitationActionState, form: FormData): Promise<CitationActionState> {
  try {
    if (!citationsEnabled()) throw new Error("Citations are switched off in this deployment.");
    const db = await createClient();
    if (!(await getCurrentTeamMember(db))) throw new Error("Only Compass team members can record credits.");
    const provider = citationText(form, "provider", 40), kind = citationText(form, "kind", 20), credits = citationText(form, "credits", 8);
    if (!PROVIDER.test(provider) || !["opening_balance", "purchase", "adjustment"].includes(kind)) throw new Error("Choose the provider and entry type.");
    if (!/^-?\d{1,7}$/.test(credits) || Number(credits) === 0 || (kind !== "adjustment" && Number(credits) < 0)) throw new Error("Enter a whole number of credits (negative only for an adjustment).");
    const occurred = citationText(form, "occurred_on", 10);
    if (!validDate(occurred) || occurred > agencyToday()) throw new Error("Choose the date, today or earlier.");
    const cash = money(form, "cash_amount");
    if (cash !== null && kind !== "purchase") throw new Error("Cash is recorded on purchases only.");
    const id = uuid(citationText(form, "id", 36));
    const { error } = await db.from("citation_credit_entries").insert({ id, provider, kind: kind as "opening_balance" | "purchase" | "adjustment",
      credits: Number(credits), cash_amount: cash, currency: currency(form, "currency"), occurred_on: occurred,
      reference: citationText(form, "reference", 300), note: citationText(form, "note", 1000) });
    if (error?.code !== "23505") dbError(error, "The entry could not be saved. Your entry is kept for retry.");
    revalidatePath("/citations");
    return { savedId: id };
  } catch (e) { return failure(e); }
}

// ── Import ────────────────────────────────────────────────────────────────

export type ImportFormat = "generic" | "brightlocal_campaign";
export type ImportRequest = {
  importId: string;
  fileName: string;
  csv: string;
  provider: string;
  /** generic: the teammate's column mapping; brightlocal_campaign: the reviewed export contract (mapping ignored). */
  format?: ImportFormat;
  campaign?: string;
  mapping: ColumnMapping;
  locations: LocationMapping;
  createDirectories: boolean;
};
export type ImportRowResult = { row_number: number; outcome: "added" | "updated" | "skipped" | "rejected" | "held"; listing_id: string | null; message: string };
export type ImportResult = {
  error?: string;
  committed?: boolean;
  already_committed?: boolean;
  rows_total?: number; added?: number; updated?: number; skipped?: number; rejected?: number; held?: number;
  new_directories?: string[];
  /** A provider-format preparation's own counts (BrightLocal campaign: footer, raw statuses, raw Notes excluded). */
  source?: { directoryRows: number; footerRows: number; byRawStatus: Record<string, number>; rawNotesExcluded: number };
  rows?: ImportRowResult[];
};

/** Preview (commit = false) and commit run the same database path; the preview is rolled back. */
export async function runCitationImportAction(clientId: string, req: ImportRequest, commit: boolean): Promise<ImportResult> {
  try {
    const db = await team(clientId);
    uuid(req.importId);
    if (typeof req.csv !== "string" || Buffer.byteLength(req.csv, "utf8") > IMPORT_MAX_BYTES) throw new Error("The file is larger than 900 KB. Split it and import each part.");
    if (!PROVIDER.test(req.provider)) throw new Error("Choose where this file came from.");
    const { data: locs, error } = await db.from("citation_locations").select("id").eq("client_id", clientId).eq("status", "active");
    if (error) throw new Error("Business locations could not be read. Retry.");
    const ids = new Set((locs ?? []).map((l) => l.id));
    const table = parseCsv(req.csv);
    let prepared: ReturnType<typeof prepareImport>, mapping: Record<string, unknown>, held: { row_number: number; reason: string }[] = [];
    let source: ImportResult["source"];
    if (req.format === "brightlocal_campaign") {
      // One campaign export = one business location, chosen by the teammate; raw Notes are never read.
      if (req.locations.mode !== "single") throw new Error("A BrightLocal campaign export belongs to one business location. Choose it.");
      const bl = prepareBrightLocalCampaign(table, { locationLabel: "campaign location", campaign: req.campaign });
      prepared = prepareImport(bl.rows, GENERIC_MAPPING, req.locations, ids, undefined, (i) => bl.sourceRows[i]);
      held = bl.held.map((h) => ({ row_number: h.row_number, reason: h.reason }));
      source = { directoryRows: bl.counts.directoryRows, footerRows: bl.counts.footerRows, byRawStatus: bl.counts.byRawStatus, rawNotesExcluded: bl.counts.rawNotesExcluded };
      mapping = { format: "brightlocal_campaign", campaign: req.campaign || null, location: storedLocationMapping(req.locations, ids), raw_notes: "excluded", source };
    } else {
      prepared = prepareImport(table, req.mapping, req.locations, ids);
      // The mapping is kept by header name; credential-like headers can never be in it (prepareImport refuses them).
      const columns = Object.fromEntries(Object.entries(req.mapping).filter(([, i]) => i !== undefined).map(([f, i]) => [f, prepared.headers[i as number]]));
      mapping = { format: "generic", columns: columns as Partial<Record<ImportField, string>>, location: storedLocationMapping(req.locations, ids), credential_columns_ignored: prepared.headers.filter(isCredentialHeader).length };
    }
    const { data, error: rpcError } = await db.rpc("citation_import", {
      p_import: { id: req.importId, client_id: clientId, provider: req.provider, file_name: storedFileName(req.fileName),
        file_sha256: createHash("sha256").update(req.csv).digest("hex"), create_directories: req.createDirectories, mapping: mapping as Json },
      p_rows: prepared.accepted, p_rejected: prepared.rejected, p_commit: commit, p_held: held,
    });
    if (rpcError) throw new Error(rpcError.code === "42501" ? rpcError.message : "The import could not run. Nothing was saved; retry.");
    if (commit) refresh(clientId);
    return { ...(data as ImportResult), source };
  } catch (e) { return { error: e instanceof Error ? e.message : "The import could not run." }; }
}
