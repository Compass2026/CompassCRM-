// Shared helpers for the client portal. Everything here is written for the
// client's eyes: no internal task wording, no owner names, no stage jargon
// that only means something to us.

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatMonth(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US");
}

// Stage names are ours; these are the client-facing versions. Anything not
// listed falls back to the stage name, which is already plain English.
const stageLabels: Record<string, string> = {
  "Brand Build": "Brand and messaging",
  "Onboarding & Service Taxonomy": "Services and positioning",
  "Keyword Research": "Keyword research",
  "Audit & Adjust": "Website audit",
  "GBP Setup & Optimisation": "Google Business Profile",
  "Local Citations": "Local directory listings",
  "Backlink Foundation": "Link building",
  "Tracking Setup": "Tracking and reporting setup",
  "Build to 70%": "Website build",
  "Polish & client review": "Website review",
  Launch: "Website launch",
  Discovery: "Discovery",
};

export function stageLabel(stage: string | null): string {
  if (!stage) return "";
  return stageLabels[stage] ?? stage;
}

export const progressStatusLabels: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "On hold",
  skipped: "Not needed",
  complete: "Done",
};

export const progressStatusStyles: Record<string, string> = {
  not_started: "bg-zinc-100 text-zinc-600 border-zinc-200",
  in_progress: "bg-blue-100 text-blue-800 border-blue-200",
  blocked: "bg-amber-100 text-amber-800 border-amber-200",
  skipped: "bg-zinc-100 text-zinc-500 border-zinc-200",
  complete: "bg-green-100 text-green-800 border-green-200",
};

// change_log.change_type is free text written by the worker; map the ones we
// use and title-case anything new rather than showing a raw slug.
const workLabels: Record<string, string> = {
  content: "Website content updated",
  page: "Page updated",
  page_group: "Page plan updated",
  keyword: "Keywords updated",
  service: "Services updated",
  technical: "Technical fix",
  seo: "SEO improvement",
  gbp: "Google Business Profile updated",
  citation: "Directory listing updated",
  backlink: "Link building",
  site: "Website change",
};

export function workLabel(kind: string | null, label: string | null): string {
  if (kind === "post") return label ?? "New blog post";
  if (!label) return "Update";
  return (
    workLabels[label] ??
    label.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

// A rank that moved up is a smaller number, so the arithmetic reads backwards.
export function rankDelta(
  position: number | null,
  previous: number | null
): { direction: "up" | "down" | "flat" | "new"; amount: number } {
  if (position == null) return { direction: "flat", amount: 0 };
  if (previous == null) return { direction: "new", amount: 0 };
  if (previous === position) return { direction: "flat", amount: 0 };
  return previous > position
    ? { direction: "up", amount: previous - position }
    : { direction: "down", amount: position - previous };
}
