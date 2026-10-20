import Link from "next/link";
import { FRESHNESS_LABELS, FULFILLMENT_STATUSES, VERIFICATION_STATUSES, evidenceFreshness, type FieldComparison, type FulfillmentStatus, type VerificationStatus } from "@/lib/citations";
import { LISTING_VIEWS, type ListingView, type LocationSummary } from "@/lib/citations-data";

const VERIFY_STYLE: Record<VerificationStatus, string> = {
  unverified: "bg-slate-100 text-slate-700", verified_accurate: "bg-emerald-50 text-emerald-800", discrepancy: "bg-red-50 text-red-800",
  inaccessible: "bg-amber-50 text-amber-800", confirmed_absent: "bg-violet-50 text-violet-800",
};
const FULFILL_STYLE: Record<FulfillmentStatus, string> = {
  none: "bg-slate-50 text-slate-600", submitted: "bg-blue-50 text-blue-800", pending: "bg-blue-50 text-blue-800", provider_complete: "bg-sky-50 text-sky-800", failed: "bg-red-50 text-red-800",
};
const pill = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap";

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  return <span className={`${pill} ${VERIFY_STYLE[status]}`} data-verification={status}>{VERIFICATION_STATUSES[status]}</span>;
}
export function FulfillmentBadge({ status }: { status: FulfillmentStatus }) {
  return <span className={`${pill} ${FULFILL_STYLE[status]}`} data-fulfillment={status}>Provider: {FULFILLMENT_STATUSES[status].replace(/^Provider /, "").toLowerCase()}</span>;
}
export function FreshnessBadge({ lastCheckedOn }: { lastCheckedOn: string | null }) {
  const f = evidenceFreshness(lastCheckedOn);
  return <span className={`${pill} ${f === "current" ? "bg-emerald-50 text-emerald-800" : f === "stale" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`} data-freshness={f}>
    {FRESHNESS_LABELS[f]}{lastCheckedOn ? ` · ${lastCheckedOn}` : ""}</span>;
}
const FIELD_STYLE: Record<FieldComparison, [string, string]> = {
  match: ["bg-emerald-50 text-emerald-800", "matches"], mismatch: ["bg-red-50 text-red-800", "differs"],
  not_observed: ["bg-slate-100 text-slate-600", "not recorded"], exposed: ["bg-red-50 text-red-800", "shown but should be hidden"],
};
export function FieldChip({ field, value }: { field: string; value: FieldComparison }) {
  return <span className={`${pill} ${FIELD_STYLE[value][0]}`} data-field={field} data-compare={value}>{field} {FIELD_STYLE[value][1]}</span>;
}

export function SummaryCards({ s }: { s: LocationSummary }) {
  const cards: [string, number, string][] = [
    ["Listings", s.total, ""], ["Verified accurate", s.byVerification.verified_accurate, "text-emerald-800"],
    ["Discrepancies", s.byVerification.discrepancy, "text-red-800"], ["Unverified", s.byVerification.unverified, ""],
    ["Provider complete, not verified", s.providerCompleteUnverified, "text-amber-800"], ["Open tasks", s.openTasks, ""],
    ["Stale / never checked", s.stale + s.never, ""], ["Action required", s.action, "text-red-800"],
  ];
  return <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-citation-summary>{cards.map(([label, value, tone]) =>
    <div key={label} className="surface p-4"><dd className={`text-2xl font-semibold ${tone}`} data-metric={label}>{value}</dd><dt className="mt-1 text-xs text-muted-foreground">{label}</dt></div>)}</dl>;
}

export function ViewNav({ base, view, extra = "" }: { base: string; view: ListingView; extra?: string }) {
  return <nav className="flex flex-wrap gap-2" aria-label="Listing filters">{Object.entries(LISTING_VIEWS).map(([k, v]) => {
    const href = k === "all" ? `${base}${extra ? `?${extra}` : ""}` : `${base}?view=${k}${extra ? `&${extra}` : ""}`;
    return <Link key={k} href={href} aria-current={view === k ? "page" : undefined}
      className={`rounded-full px-3 py-2 text-xs font-medium ${view === k ? "bg-blue-700 text-white" : "bg-blue-50 text-blue-800"}`}>{v}</Link>;
  })}</nav>;
}

export function PhaseNote() {
  return <p className="text-xs text-muted-foreground">Phase 1: inventory, mapped CSV import, manual evidence and the correction queue. Nothing here crawls directories,
    places provider orders or spends credits. A provider&apos;s &quot;complete&quot; is shown separately and never counts as verified; a search that finds nothing is not proof of absence.
    Evidence older than 90 days is stale.</p>;
}
