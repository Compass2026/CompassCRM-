/**
 * Citations Phase 1: provider-neutral listing inventory. Pure helpers shared by
 * the pages, the server actions and tests/citations.test.mjs. Nothing here
 * calls a provider, crawls a directory or spends money.
 *
 * Three separate dimensions, never merged:
 * - fulfillment: what a provider (or a teammate) says happened to a submission
 * - verification: what a teammate independently observed on the public listing
 * - open issues: correction / verification tasks still open
 * A provider's "complete" never sets verification; "not found in a search" is
 * recorded but is not proof of absence.
 */
import { agencyToday, validDate } from "./reporting.ts";

export const FULFILLMENT_STATUSES = {
  none: "No provider action",
  submitted: "Submitted",
  pending: "Pending",
  provider_complete: "Provider complete",
  failed: "Failed",
} as const;
export type FulfillmentStatus = keyof typeof FULFILLMENT_STATUSES;

export const VERIFICATION_STATUSES = {
  unverified: "Unverified",
  verified_accurate: "Verified accurate",
  discrepancy: "Discrepancy",
  inaccessible: "Inaccessible",
  confirmed_absent: "Confirmed absent",
  // Derived, never stored: the latest check was made against an older approved identity.
  needs_reverification: "Needs reverification",
} as const;
export type VerificationStatus = keyof typeof VERIFICATION_STATUSES;

/** A teammate's check. not_found is evidence of a search, not of absence. */
export const CHECK_RESULTS = {
  accurate: "Listing matches the approved identity",
  discrepancy: "Listing differs from the approved identity",
  inaccessible: "Listing could not be opened",
  not_found: "Searched, not found (not proof of absence)",
  confirmed_absent: "Confirmed absent by the publisher or owner dashboard",
} as const;
export type CheckResult = keyof typeof CHECK_RESULTS;

export const CHECK_METHODS = {
  visited_url: "Opened the listing URL",
  publisher_search: "Searched the publisher",
  owner_dashboard: "Owner / management dashboard",
  publisher_confirmation: "Written publisher confirmation",
  other: "Other (explain in evidence)",
} as const;
export type CheckMethod = keyof typeof CHECK_METHODS;

/** Which methods may support which result (the database enforces the same). */
export const RESULT_METHODS: Record<CheckResult, CheckMethod[]> = {
  accurate: ["visited_url", "owner_dashboard"],
  discrepancy: ["visited_url", "owner_dashboard"],
  inaccessible: ["visited_url", "other"],
  not_found: ["publisher_search", "other"],
  confirmed_absent: ["owner_dashboard", "publisher_confirmation"],
};

export const TASK_KINDS = {
  verify: "Verify listing",
  correct: "Correct listing",
  remove_duplicate: "Resolve suspected duplicate",
  create_listing: "Create listing",
  investigate: "Investigate",
} as const;
export type CitationTaskKind = keyof typeof TASK_KINDS;
export const TASK_STATUSES = { open: "Open", in_progress: "In progress", waiting: "Waiting", resolved: "Resolved", cancelled: "Cancelled" } as const;
export type CitationTaskStatus = keyof typeof TASK_STATUSES;
export const OPEN_TASK_STATUSES: CitationTaskStatus[] = ["open", "in_progress", "waiting"];

export const REQUEST_ACTIONS = { create: "Create listing", update: "Update listing", remove_duplicate: "Remove / suppress duplicate", other: "Other" } as const;
export type RequestAction = keyof typeof REQUEST_ACTIONS;
export const REQUEST_STATUSES = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved (not ordered)",
  submitted: "Submitted to provider",
  provider_complete: "Provider complete",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;
export type RequestStatus = keyof typeof REQUEST_STATUSES;

/**
 * Evidence is current only when the latest check is at most 90 days old AND
 * was made against the location's current approved identity. Anything else is
 * reported, never counted as current.
 */
export const CITATION_STALE_DAYS = 90;
export type Freshness = "current" | "stale" | "superseded" | "none";
export function evidenceFreshness(lastCheckedOn: string | null, today = agencyToday(), identityCurrent = true): Freshness {
  if (!lastCheckedOn) return "none";
  if (!identityCurrent) return "superseded";
  return (Date.parse(today) - Date.parse(lastCheckedOn)) / 86400000 > CITATION_STALE_DAYS ? "stale" : "current";
}
export const FRESHNESS_LABELS: Record<Freshness, string> = { current: "Current evidence", stale: "Stale evidence", superseded: "Identity changed since check", none: "Never checked" };
/** The check behind the current status was made against the current approved identity. */
export function identityCurrent(l: { check_identity_version: number | null; identity_version: number }) {
  return l.check_identity_version === null || l.check_identity_version === l.identity_version;
}

// ── Identity and comparison ────────────────────────────────────────────────

export type CitationIdentity = {
  business_name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  phone: string;
  website_url: string | null;
  hide_address: boolean;
};

export function identityAddress(i: Pick<CitationIdentity, "address_line1" | "address_line2" | "city" | "region" | "postal_code">) {
  return [i.address_line1, i.address_line2, [i.city, [i.region, i.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")]
    .filter((p) => p && p.trim()).join(", ");
}

/** The address as it may appear outside the team: never the street of a hidden-address business. */
export function publicAddress(i: CitationIdentity) {
  return i.hide_address ? `Hidden (service-area business)${i.city ? ` · ${i.city}${i.region ? `, ${i.region}` : ""}` : ""}` : identityAddress(i);
}

const ADDRESS_WORDS: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln", court: "ct", place: "pl", highway: "hwy",
  parkway: "pkwy", suite: "ste", apartment: "apt", building: "bldg", north: "n", south: "s", east: "e", west: "w", unit: "ste", "#": "ste",
};
export function normalizeName(v: string) {
  return v.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\b(llc|inc|co|corp|ltd|the)\b/g, " ").replace(/\s+/g, " ").trim();
}
export function normalizePhone(v: string) {
  const d = v.replace(/\D+/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}
export function normalizeAddress(v: string) {
  return v.toLowerCase().replace(/\b(\d{5})-\d{4}\b/g, "$1").replace(/#/g, " # ").replace(/[^a-z0-9# ]+/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => ADDRESS_WORDS[w] ?? w).join(" ").replace(/\b(usa|us|united states)$/g, "").trim();
}
export function normalizeWebsite(v: string) {
  try {
    const u = new URL(/^https?:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch { return v.trim().toLowerCase(); }
}

export type FieldComparison = "match" | "mismatch" | "not_observed" | "exposed";
export type ObservedFields = { observed_name: string; observed_address: string; observed_phone: string; observed_website: string };

/** Field-by-field comparison against the approved identity. A suggestion for the teammate, never a verdict. */
export function compareListing(identity: CitationIdentity, observed: ObservedFields): Record<"name" | "address" | "phone" | "website", FieldComparison> {
  const cmp = (seen: string, want: string, norm: (v: string) => string): FieldComparison =>
    !seen.trim() ? "not_observed" : norm(seen) === norm(want) ? "match" : "mismatch";
  return {
    name: cmp(observed.observed_name, identity.business_name, normalizeName),
    address: identity.hide_address
      ? observed.observed_address.trim() ? "exposed" : "not_observed"
      : cmp(observed.observed_address, identityAddress(identity), normalizeAddress),
    phone: cmp(observed.observed_phone, identity.phone, normalizePhone),
    website: cmp(observed.observed_website, identity.website_url ?? "", normalizeWebsite),
  };
}

/** The listing's natural key within a location and directory: its URL, else its external id, else the one URL-less slot. */
export function listingKey(listingUrl: string | null, externalId: string | null) {
  if (listingUrl) {
    const u = new URL(listingUrl);
    return `url:${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  }
  return externalId ? `ext:${externalId.trim().toLowerCase()}` : "none";
}

export function listingUrl(value: string): string {
  let u: URL;
  try { u = new URL(value.trim()); } catch { throw new Error("Listing URL must be a complete http or https address."); }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || !u.hostname.includes(".") || /\s/.test(value.trim()))
    throw new Error("Listing URL must be a public http or https address without credentials.");
  u.hash = "";
  return u.href;
}

// ── CSV ────────────────────────────────────────────────────────────────────

// Server actions accept 1 MB bodies (Next's default); leave room for the form.
export const IMPORT_MAX_BYTES = 900_000;
export const IMPORT_MAX_ROWS = 5000;

/** RFC 4180 with the usual spreadsheet leniencies: BOM, CRLF / LF, quoted newlines, a trailing newline. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { quoted = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(cell); rows.push(row); row = []; cell = "";
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch; i++;
  }
  if (quoted) throw new Error("The file ends inside a quoted cell. Check that every opening quote is closed.");
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Columns that look like logins are never offered for mapping and never stored. */
export function isCredentialHeader(header: string) {
  return /pass(word)?|passwd|\bpwd\b|secret|token|api[\s_-]?key|credential|\blogin\b|user ?name|\bpin\b|security (question|answer)/i.test(header);
}

export const IMPORT_FIELDS = {
  location: { label: "Business location", hint: "Mapped to a location you choose below; never guessed." },
  directory: { label: "Directory / publisher", hint: "Name or domain, matched to the directory registry." },
  listing_url: { label: "Listing URL", hint: "" },
  external_id: { label: "External listing id", hint: "" },
  fulfillment_status: { label: "Provider status", hint: "Submitted / pending / complete / failed. Never sets verification." },
  observed_name: { label: "Observed business name", hint: "" },
  observed_address: { label: "Observed address", hint: "" },
  observed_phone: { label: "Observed phone", hint: "" },
  observed_website: { label: "Observed website", hint: "" },
  source_observed_on: { label: "Source observation date", hint: "When the source saw the listing, if supplied." },
  notes: { label: "Notes", hint: "" },
} as const;
export type ImportField = keyof typeof IMPORT_FIELDS;
export type ColumnMapping = Partial<Record<ImportField, number>>;

const FIELD_HEADERS: Record<ImportField, RegExp> = {
  location: /^(location|location name|business location|branch|store|office)$/i,
  directory: /^(directory|site|source site|publisher|citation source|website name|platform)$/i,
  listing_url: /^(listing url|url|citation url|link|listing link|profile url)$/i,
  external_id: /^(listing id|external id|id at source|profile id)$/i,
  fulfillment_status: /^(status|submission status|provider status|campaign status)$/i,
  observed_name: /^(business name|name|listing name|observed name)$/i,
  observed_address: /^(address|listing address|observed address|full address)$/i,
  observed_phone: /^(phone|telephone|phone number|listing phone|observed phone)$/i,
  observed_website: /^(website|website url|listing website|observed website)$/i,
  source_observed_on: /^(date|checked|last checked|date found|observed on|found on|date checked)$/i,
  notes: /^(notes?|comments?)$/i,
};
/** A first guess by exact, generic header names. The teammate confirms every column. Not a provider schema. */
export function guessMapping(headers: string[]): ColumnMapping {
  const out: ColumnMapping = {};
  headers.forEach((h, i) => {
    if (isCredentialHeader(h)) return;
    for (const [field, re] of Object.entries(FIELD_HEADERS) as [ImportField, RegExp][])
      if (out[field] === undefined && re.test(h.trim())) { out[field] = i; break; }
  });
  return out;
}

const STATUS_WORDS: Record<string, FulfillmentStatus> = {
  "": "none", none: "none", "not submitted": "none",
  submitted: "submitted", "sent": "submitted",
  pending: "pending", "in progress": "pending", processing: "pending", queued: "pending",
  complete: "provider_complete", completed: "provider_complete", done: "provider_complete", live: "provider_complete", "provider complete": "provider_complete",
  failed: "failed", error: "failed", rejected: "failed",
};
export function fulfillmentFromText(v: string): FulfillmentStatus | null {
  return STATUS_WORDS[v.trim().toLowerCase().replace(/[_-]+/g, " ")] ?? null;
}

export function parseSourceDate(v: string, today = agencyToday()): string | null {
  const t = v.trim();
  if (!t) return null;
  let iso = t.slice(0, 10);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (us) iso = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  if (!validDate(iso)) throw new Error(`Observation date "${t.slice(0, 30)}" is not a date (use YYYY-MM-DD or MM/DD/YYYY).`);
  if (iso > today) throw new Error("Observation date is in the future.");
  return iso;
}

export type ImportRow = {
  row_number: number;
  row_hash: string;
  location_id: string;
  directory: string;
  listing_url: string | null;
  external_id: string | null;
  fulfillment_status: FulfillmentStatus | null;
  observed_name: string | null;
  observed_address: string | null;
  observed_phone: string | null;
  observed_website: string | null;
  source_observed_on: string | null;
  notes: string | null;
};
export type RejectedRow = { row_number: number; reason: string };
export type LocationMapping = { mode: "single"; locationId: string } | { mode: "column"; values: Record<string, string> };

/** FNV-1a over the mapped values: identifies a row's content without storing it. */
export function rowHash(values: string[]) {
  let h = 0x811c9dc5;
  for (const ch of values.join("\u001f")) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/**
 * Validates every data row against the mapping. Rows that cannot be placed on
 * a location the teammate mapped, or that carry an invalid value, are rejected
 * with a reason; nothing is guessed. Credential-like columns are ignored.
 */
export function prepareImport(rows: string[][], mapping: ColumnMapping, locations: LocationMapping, locationIds: Set<string>, today = agencyToday()) {
  if (!rows.length) throw new Error("The file has no header row.");
  const [headers, ...data] = rows;
  if (data.length > IMPORT_MAX_ROWS) throw new Error(`The file has ${data.length} rows; the limit is ${IMPORT_MAX_ROWS}. Split it and import each part.`);
  for (const [field, col] of Object.entries(mapping)) {
    if (col === undefined) continue;
    if (!Number.isInteger(col) || col < 0 || col >= headers.length) throw new Error(`The column chosen for ${field} is not in the file.`);
    if (isCredentialHeader(headers[col])) throw new Error(`"${headers[col]}" looks like a login column and cannot be imported.`);
  }
  if (mapping.directory === undefined && mapping.listing_url === undefined) throw new Error("Map a directory column or a listing URL column.");
  if (locations.mode === "column" && mapping.location === undefined) throw new Error("Choose the column that names each row's location.");
  if (locations.mode === "single" && !locationIds.has(locations.locationId)) throw new Error("Choose a business location for this file.");
  const accepted: ImportRow[] = [], rejected: RejectedRow[] = [];
  data.forEach((cells, index) => {
    const row_number = index + 2;
    const cell = (f: ImportField, max = 1000) => {
      const col = mapping[f];
      const v = col === undefined ? "" : (cells[col] ?? "").trim();
      if (v.length > max) throw new Error(`${IMPORT_FIELDS[f].label} is longer than ${max} characters.`);
      return v;
    };
    try {
      let location_id: string;
      if (locations.mode === "single") location_id = locations.locationId;
      else {
        const label = cell("location", 200);
        if (!label) throw new Error("No location in this row.");
        const mapped = locations.values[label];
        if (!mapped || !locationIds.has(mapped)) throw new Error(`Location "${label}" is not mapped to a business location.`);
        location_id = mapped;
      }
      const rawUrl = cell("listing_url", 2000);
      const url = rawUrl ? listingUrl(rawUrl) : null;
      const directory = cell("directory", 200) || (url ? new URL(url).hostname.toLowerCase().replace(/^www\./, "") : "");
      if (!directory) throw new Error("No directory and no listing URL in this row.");
      const statusText = cell("fulfillment_status", 100);
      const fulfillment_status = mapping.fulfillment_status === undefined || !statusText ? null : fulfillmentFromText(statusText);
      if (statusText && !fulfillment_status) throw new Error(`Provider status "${statusText.slice(0, 40)}" is not one of submitted, pending, complete or failed.`);
      const observedSite = cell("observed_website", 2000);
      const values = { location_id, directory, listing_url: url, external_id: cell("external_id", 200) || null, fulfillment_status,
        observed_name: cell("observed_name", 300) || null, observed_address: cell("observed_address", 500) || null,
        observed_phone: cell("observed_phone", 50) || null, observed_website: observedSite || null,
        source_observed_on: parseSourceDate(cell("source_observed_on", 40), today), notes: cell("notes", 2000) || null };
      accepted.push({ row_number, row_hash: rowHash(Object.values(values).map((v) => v ?? "")), ...values });
    } catch (e) {
      rejected.push({ row_number, reason: e instanceof Error ? e.message : "Invalid row." });
    }
  });
  return { headers, total: data.length, accepted, rejected };
}

/** Spreadsheet-safe cell: a leading = + - @ tab or CR (after any spaces) is neutralized with a quote. */
export function csvCell(v: unknown) {
  const s = String(v ?? "");
  return `"${(/^[\s]*[=+\-@\t\r]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
}
export function toCsv(rows: unknown[][]) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** The current-evidence projection (citation_listing_overview) plus what a report needs. */
export type ExportListing = Pick<CitationListingOverview,
  "client_name" | "location_label" | "directory_name" | "listing_url" | "external_id" | "fulfillment_status" | "verification_status"
  | "last_checked_on" | "last_check_result" | "check_identity_version" | "identity_version" | "current_name" | "current_address" | "current_phone"
  | "current_website" | "source_provider" | "source_observed_on" | "last_imported_at" | "source_name" | "source_address" | "source_phone"
  | "source_website" | "open_tasks" | "suspected_duplicate"> & { identity: CitationIdentity };

export const EXPORT_HEADERS = ["Client", "Location", "Directory", "Listing URL", "External id", "Provider status", "Verification", "Evidence",
  "Last checked", "Last check result", "Checked against identity", "Current identity", "Current name", "Current address", "Current phone",
  "Current website", "Source", "Source observed", "Imported at", "Source name", "Source address", "Source phone", "Source website",
  "Open tasks", "Suspected duplicate", "Approved address"];

/**
 * Report rows from the same projection the pages read. "Current" values are
 * the latest teammate check's observations (blank = not recorded, or the check
 * could not observe the listing); "Source" values are the import's, with
 * their own dates. The client-safe variant never carries the street address
 * of a hidden-address business, approved, checked or imported; the internal
 * one marks it.
 */
export function exportRows(listings: ExportListing[], variant: "client" | "internal", today = agencyToday()) {
  return [EXPORT_HEADERS, ...listings.map((l) => {
    const hidden = l.identity.hide_address;
    const address = (v: string) => hidden && variant === "client" ? (v ? "Address shown publicly (should be hidden)" : "") : v;
    const approved = variant === "client" ? publicAddress(l.identity) : `${identityAddress(l.identity)}${hidden ? " [HIDDEN — internal only]" : ""}`;
    return [l.client_name, l.location_label, l.directory_name, l.listing_url ?? "", l.external_id ?? "", FULFILLMENT_STATUSES[l.fulfillment_status],
      VERIFICATION_STATUSES[l.verification_status], FRESHNESS_LABELS[evidenceFreshness(l.last_checked_on, today, identityCurrent(l))], l.last_checked_on ?? "",
      l.last_check_result ? CHECK_RESULTS[l.last_check_result] : "", l.check_identity_version ?? "", l.identity_version,
      l.current_name, address(l.current_address), l.current_phone, l.current_website,
      l.source_provider ?? "", l.source_observed_on ?? "", l.last_imported_at ?? "",
      l.source_name, address(l.source_address), l.source_phone, l.source_website,
      l.open_tasks, l.suspected_duplicate ? "yes" : "", approved];
  })];
}

/** "Action required": a discrepancy, an inaccessible listing, an identity change nobody has rechecked, an open task, or a provider claim nobody has verified. */
export function needsAction(l: { verification_status: VerificationStatus; fulfillment_status: FulfillmentStatus; open_tasks: number; suspected_duplicate: boolean }) {
  return l.verification_status === "discrepancy" || l.verification_status === "inaccessible" || l.verification_status === "needs_reverification"
    || l.open_tasks > 0 || l.suspected_duplicate
    || (l.fulfillment_status === "provider_complete" && l.verification_status === "unverified");
}

export function citationText(form: FormData, key: string, max = 1000) {
  const v = form.get(key);
  if (v === null) return "";
  if (typeof v !== "string" || v.trim().length > max) throw new Error(`Check ${key.replaceAll("_", " ")}.`);
  return v.trim();
}

// ── Row shapes (registered in database.types.ts) ──────────────────────────

export type CitationLocation = CitationIdentity & {
  id: string; client_id: string; brand_workspace_id: string | null; tracking_location_id: string | null; label: string;
  status: "active" | "archived"; identity_version: number; identity_note: string; approved_at: string; approved_by: string | null;
  notes: string; created_at: string; updated_at: string;
};
export type CitationLocationIdentity = CitationIdentity & { id: string; location_id: string; version: number; note: string; recorded_at: string; recorded_by: string | null };
export type CitationDirectory = { id: string; key: string; name: string; domain: string | null; kind: string; hidden_address_support: "unknown" | "supported" | "not_supported"; is_active: boolean; created_at: string; created_by: string | null };
export type SourceFields = { source_name: string; source_address: string; source_phone: string; source_website: string };
export type CitationListing = SourceFields & {
  id: string; client_id: string; location_id: string; directory_id: string; listing_url: string | null; external_id: string | null; listing_key: string;
  fulfillment_status: FulfillmentStatus; source_provider: string | null; source_observed_on: string | null;
  last_import_id: string | null; last_imported_at: string | null; archived: boolean;
  notes: string; created_at: string; updated_at: string; created_by: string | null;
};
/** citation_listing_overview: the listing, its latest check, the identity-aware status and the current observations. */
export type CitationListingOverview = CitationListing & {
  directory_name: string; directory_key: string; location_label: string; hide_address: boolean; identity_version: number; client_name: string;
  last_check_id: string | null; last_checked_on: string | null; last_check_result: CheckResult | null; last_check_method: CheckMethod | null;
  check_identity_version: number | null; verification_status: VerificationStatus;
  current_name: string; current_address: string; current_phone: string; current_website: string;
  open_tasks: number; suspected_duplicate: boolean;
};
/** The observation a comparison should use: the latest content check, else the import's (flagged as such), else nothing. */
export function comparisonSource(l: CitationListingOverview): { from: "check" | "source" | "none"; fields: ObservedFields } {
  if (l.last_check_result === "accurate" || l.last_check_result === "discrepancy")
    return { from: "check", fields: { observed_name: l.current_name, observed_address: l.current_address, observed_phone: l.current_phone, observed_website: l.current_website } };
  if (!l.last_check_id && (l.source_name || l.source_address || l.source_phone || l.source_website))
    return { from: "source", fields: { observed_name: l.source_name, observed_address: l.source_address, observed_phone: l.source_phone, observed_website: l.source_website } };
  return { from: "none", fields: { observed_name: "", observed_address: "", observed_phone: "", observed_website: "" } };
}
export type CitationCheck = ObservedFields & {
  id: string; listing_id: string; identity_version: number; checked_on: string; method: CheckMethod; result: CheckResult;
  evidence: string; evidence_url: string | null; recorded_at: string; recorded_by: string | null;
};
export type CitationTask = {
  id: string; client_id: string; location_id: string; listing_id: string | null; kind: CitationTaskKind; reason: string; status: CitationTaskStatus;
  assignee_id: string | null; due_on: string | null; opened_at: string; opened_by: string | null; resolved_on: string | null; resolved_at: string | null;
  resolved_by: string | null; resolution: string; evidence_ref: string; check_id: string | null; updated_at: string;
};
export type CitationRequest = {
  id: string; client_id: string; location_id: string; directory_id: string; listing_id: string | null; action: RequestAction; provider: string;
  provider_reference: string; status: RequestStatus; approved_budget: number | null; budget_currency: string; approved_at: string | null; approved_by: string | null;
  actual_amount: number | null; actual_currency: string; credits_used: number | null; notes: string; requested_by: string | null; created_at: string; updated_at: string;
};
export type CitationCreditEntry = { id: string; provider: string; kind: "opening_balance" | "purchase" | "adjustment"; credits: number; cash_amount: number | null; currency: string; occurred_on: string; reference: string; note: string; recorded_at: string; recorded_by: string | null };
export type CitationCreditBalance = { provider: string; credits_recorded: number; credits_used: number; credit_purchase_cash: number };
export type CitationImport = { id: string; client_id: string; file_name: string; file_sha256: string; provider: string; mapping: unknown; rows_total: number; added: number; updated: number; skipped: number; rejected: number; created_at: string; created_by: string | null };
