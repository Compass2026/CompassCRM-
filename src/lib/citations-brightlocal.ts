/**
 * BrightLocal Citation Builder campaign export → the generic import.
 *
 * Contract taken from a real campaign export (Logic Solar Overland Park,
 * campaign 908272, reviewed Oct 20 2026): nine columns in this order, one row
 * per directory attempt, and a trailing single-cell footer ("Aggregator/
 * Network") that is not a listing.
 *
 * - Live / Updated → provider_complete; Submitted → submitted. Neither is
 *   verification.
 * - Every other status (Unavailable, blank, anything new) is HELD for review /
 *   history: never a listing, never proof of absence, never spend.
 * - "Submitted" is the provider's submission date. It is never an observation
 *   date and is not mapped to source_observed_on.
 * - The raw Notes column is never read into anything. Real exports carry
 *   logins and tokenized verification links there. Only a separately reviewed
 *   safe summary per row (safeNotes) can be added, and it is screened too.
 *
 * The BrightLocal UI shows some attempts as "Replaced"; the CSV does not say
 * that, so the CSV's own status is what is kept.
 */
import { sensitiveContent } from "./citations.ts";

export const BRIGHTLOCAL_CAMPAIGN_COLUMNS = ["No", "Citation Site", "Type of Site", "Domain Authority", "Citation Value", "Submitted", "Status", "Citation Link", "Notes"] as const;
const COL = Object.fromEntries(BRIGHTLOCAL_CAMPAIGN_COLUMNS.map((c, i) => [c, i])) as Record<(typeof BRIGHTLOCAL_CAMPAIGN_COLUMNS)[number], number>;

export type BrightLocalHeld = { row_number: number; site: string; raw_status: string; submitted_on: string | null; reason: string };
export type BrightLocalPrepared = {
  /** Generic CSV rows (header first) for prepareImport: Location, Directory, Listing URL, Provider status, Notes. */
  rows: string[][];
  /** Source row number (spreadsheet row, header = 1) of each generic data row. */
  sourceRows: number[];
  held: BrightLocalHeld[];
  counts: { directoryRows: number; footerRows: number; active: number; providerComplete: number; submitted: number; held: number; byRawStatus: Record<string, number>; rawNotesExcluded: number };
};
export const GENERIC_MAPPING = { location: 0, directory: 1, listing_url: 2, fulfillment_status: 3, notes: 4 } as const;

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
/** "11th Nov 2025", "2025-11-11" or "11/11/2025" → ISO; anything else → null (kept as unparsed, never guessed). */
export function brightLocalDate(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  let m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}`;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

export function isBrightLocalCampaign(header: string[]) {
  return header.length === BRIGHTLOCAL_CAMPAIGN_COLUMNS.length && header.every((h, i) => h.trim().toLowerCase() === BRIGHTLOCAL_CAMPAIGN_COLUMNS[i].toLowerCase());
}

export function prepareBrightLocalCampaign(table: string[][], opts: { locationLabel: string; campaign?: string; safeNotes?: Record<string, string> }): BrightLocalPrepared {
  const [header, ...data] = table;
  if (!header || !isBrightLocalCampaign(header))
    throw new Error(`This is not a BrightLocal Citation Builder campaign export. Expected the columns ${BRIGHTLOCAL_CAMPAIGN_COLUMNS.join(", ")}.`);
  const campaign = (opts.campaign ?? "").trim();
  if (campaign && !/^\d{1,12}$/.test(campaign)) throw new Error("The campaign id is the number in the BrightLocal campaign URL.");
  const rows: string[][] = [["Location", "Directory", "Listing URL", "Provider status", "Notes"]];
  const sourceRows: number[] = [];
  const held: BrightLocalHeld[] = [];
  const byRawStatus: Record<string, number> = {};
  let footerRows = 0, directoryRows = 0, providerComplete = 0, submitted = 0, rawNotesExcluded = 0;
  data.forEach((cells, i) => {
    const sourceRow = i + 2;
    const filled = cells.filter((c) => c.trim() !== "");
    const no = (cells[COL.No] ?? "").trim();
    // The footer: one cell, no row number (e.g. "Aggregator/Network").
    if (!/^\d+$/.test(no) && filled.length <= 1) { footerRows++; return; }
    directoryRows++;
    if ((cells[COL.Notes] ?? "").trim()) rawNotesExcluded++;
    const site = (cells[COL["Citation Site"]] ?? "").trim().toLowerCase();
    const raw = (cells[COL.Status] ?? "").trim();
    const submittedText = (cells[COL.Submitted] ?? "").trim();
    const submittedOn = brightLocalDate(submittedText);
    const url = (cells[COL["Citation Link"]] ?? "").trim();
    byRawStatus[raw || "(blank)"] = (byRawStatus[raw || "(blank)"] ?? 0) + 1;
    const submittedNote = submittedOn ? `provider submitted ${submittedOn}` : submittedText ? "provider submitted date unparsed" : "no provider submitted date";
    const status = /^(live|updated)$/i.test(raw) ? "provider_complete" : /^submitted$/i.test(raw) ? "submitted" : null;
    if (!status || !site || !/^\d+$/.test(no)) {
      held.push({ row_number: sourceRow, site: site || "(no site)", raw_status: raw || "(blank)", submitted_on: submittedOn,
        reason: `Held for review: BrightLocal${campaign ? ` campaign ${campaign}` : ""} row ${no || "?"} (${site || "no site"}), CSV status ${raw || "blank"}, ${submittedNote}. Not a listing and not proof of absence.` });
      return;
    }
    const safe = opts.safeNotes?.[no]?.trim() ?? "";
    if (safe && sensitiveContent(safe)) throw new Error(`The reviewed note for row ${no} still looks like it contains a login or a private link.`);
    const note = [`BrightLocal${campaign ? ` campaign ${campaign}` : ""}; source row ${no}; CSV status ${raw}; ${submittedNote} (not an observation date)`, safe].filter(Boolean).join(". ");
    if (status === "provider_complete") providerComplete++; else submitted++;
    rows.push([opts.locationLabel, site, url, status, note]);
    sourceRows.push(sourceRow);
  });
  return { rows, sourceRows, held,
    counts: { directoryRows, footerRows, active: providerComplete + submitted, providerComplete, submitted, held: held.length, byRawStatus, rawNotesExcluded } };
}
