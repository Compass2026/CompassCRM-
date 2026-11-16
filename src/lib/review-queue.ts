// The review queue (20261116150000 review_queue): one read model across
// clients for Facebook and Business Profile posts, from review to delivery.
// Pure helpers only (stage labels, grouping, proposed publish times), so the
// page and the tests share them.

export const REVIEW_STAGES = [
  "ready",
  "needs_preparation",
  "revising",
  "blocked",
  "approved",
  "scheduled",
  "publishing",
  "failed",
  "published",
] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export const stageLabels: Record<ReviewStage, { label: string; help: string; className: string }> = {
  ready: {
    label: "Ready for final review",
    help: "Grounded copy, the image it will carry (or a stated reason for none) and a destination. Approve & schedule, approve only, or reject with feedback.",
    className: "bg-green-100 text-green-800",
  },
  needs_preparation: {
    label: "Needs preparation",
    help: "Not ready for a decision yet: a claim or service gap, or no image and no reason for going without one.",
    className: "bg-amber-100 text-amber-900",
  },
  revising: {
    label: "Revising after feedback",
    help: "Rejected with feedback. It comes back for a fresh review only once the rejected copy or image has changed.",
    className: "bg-orange-100 text-orange-900",
  },
  blocked: {
    label: "Blocked",
    help: "The client is paused or offboarded, or the post names no account. Nothing can be scheduled.",
    className: "bg-red-100 text-red-800",
  },
  approved: {
    label: "Approved, not scheduled",
    help: "Approved without a time. Approval alone never publishes; scheduling is a separate decision.",
    className: "bg-blue-100 text-blue-800",
  },
  scheduled: {
    label: "Scheduled",
    help: "Approved for this time. The publisher sends it then; reopen it to change the time.",
    className: "bg-indigo-100 text-indigo-800",
  },
  publishing: {
    label: "Publishing",
    help: "Sent to the provider; the result is not confirmed yet.",
    className: "bg-indigo-100 text-indigo-800",
  },
  failed: {
    label: "Failed",
    help: "The publisher could not send it. The error says why.",
    className: "bg-red-100 text-red-800",
  },
  published: {
    label: "Published",
    help: "Confirmed by the provider, with its link.",
    className: "bg-emerald-100 text-emerald-800",
  },
};

export function isReviewStage(s: unknown): s is ReviewStage {
  return typeof s === "string" && (REVIEW_STAGES as readonly string[]).includes(s);
}

export type QueueMedia = {
  kind: string;
  label: string | null;
  storage_path: string | null;
  bucket: "brand-assets" | "creative-assets";
  asset_id: string;
  url: string | null;
  content_hash: string | null;
  width: number | null;
  height: number | null;
};

export type QueueItem = {
  id: string;
  client_id: string;
  client_name: string;
  client_status: string;
  platform: "facebook" | "google_business";
  copy: string;
  cta_type: string | null;
  cta_url: string | null;
  service_name: string | null;
  keyword: string | null;
  review_status: string;
  publish_status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  rejection_category: string | null;
  scheduled_at: string | null;
  approved_publish_at: string | null;
  published_at: string | null;
  published_url: string | null;
  external_post_id: string | null;
  error: string | null;
  publish_attempts: number;
  no_image_reason: string | null;
  social_account_id: string | null;
  destination_name: string | null;
  destination_key: string | null;
  approved_destination: string | null;
  planned_date: string | null;
  media: QueueMedia[];
  grounding_problems: string[] | null;
  publish_problems: string[] | null;
  client_hold: string | null;
  stage: ReviewStage;
  last_feedback: string | null;
  rejections: number;
};

export function groupByStage(items: QueueItem[]): Map<ReviewStage, QueueItem[]> {
  const m = new Map<ReviewStage, QueueItem[]>(REVIEW_STAGES.map((s) => [s, []]));
  for (const i of items) m.get(isReviewStage(i.stage) ? i.stage : "needs_preparation")!.push(i);
  return m;
}

// ── Proposed publish times ──────────────────────────────────────────────────
// A proposal, never a decision: shown on each post awaiting a decision and
// pre-filled in its Approve & schedule form, where the reviewer can change it.
// Rules: the slot's planned date when it is still ahead, otherwise the next
// weekday from tomorrow; one post per destination per day (the Business
// Profile collision rule, applied to Facebook Pages too), never a day that
// destination already has scheduled; DEFAULT_HOUR Central time.
export const DEFAULT_HOUR = 10;

const DAY = 86_400_000;
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return ymd(new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY));
}
function isWeekend(day: string): boolean {
  const w = new Date(`${day}T12:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
}

// The UTC instant of `hour`:00 Central on a calendar day (DST-aware).
export function centralInstant(day: string, hour = DEFAULT_HOUR): string {
  for (const offset of [5, 6]) {
    const t = new Date(`${day}T${String(hour + offset).padStart(2, "0")}:00:00Z`);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(t);
    if (Number(local) === hour) return t.toISOString();
  }
  return new Date(`${day}T${String(hour + 6).padStart(2, "0")}:00:00Z`).toISOString();
}

// The Central calendar day of an instant.
export function centralDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));
}

export function proposeTimes(items: QueueItem[], today: string): Map<string, string> {
  const taken = new Map<string, Set<string>>();
  const take = (dest: string, day: string) => {
    if (!taken.has(dest)) taken.set(dest, new Set());
    taken.get(dest)!.add(day);
  };
  for (const i of items) {
    if (i.scheduled_at && ["scheduled", "publishing"].includes(i.stage)) take(i.destination_key ?? i.id, centralDay(i.scheduled_at));
  }
  const open = items
    .filter((i) => i.stage === "ready" || i.stage === "needs_preparation" || i.stage === "approved")
    .sort((a, b) =>
      (a.planned_date ?? "9999").localeCompare(b.planned_date ?? "9999") ||
      (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "") ||
      a.id.localeCompare(b.id)
    );
  const out = new Map<string, string>();
  const tomorrow = addDays(today, 1);
  for (const i of open) {
    const dest = i.destination_key ?? i.id;
    let day = i.planned_date && i.planned_date >= tomorrow ? i.planned_date : tomorrow;
    for (let n = 0; n < 60 && (isWeekend(day) || taken.get(dest)?.has(day)); n++) day = addDays(day, 1);
    take(dest, day);
    out.set(i.id, centralInstant(day));
  }
  return out;
}

// The value for an <input type="datetime-local"> in Central time.
export function centralLocalInput(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

export function formatCentral(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso)) + " CT";
}

// What a reviewer can decide on a queue item, and why not.
export function decisionsFor(i: QueueItem): { approveAndSchedule: boolean; approveOnly: boolean; reject: boolean; why: string | null } {
  if (i.stage !== "ready") return { approveAndSchedule: false, approveOnly: false, reject: i.review_status === "in_review", why: null };
  const publishBlocked = (i.publish_problems ?? []).length > 0;
  return {
    approveAndSchedule: !publishBlocked,
    approveOnly: true,
    reject: true,
    why: publishBlocked ? `Approve only: the publisher would not send it (${(i.publish_problems ?? []).join(" ")})` : null,
  };
}

// A datetime-local value read as Central time → UTC ISO (DST-aware).
export function centralToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const guess = new Date(`${local}:00Z`);
  if (Number.isNaN(guess.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asCentral = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() - (asCentral - guess.getTime())).toISOString();
}
