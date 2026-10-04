// Content Planner (0064): the weekly production targets, labels and the
// arithmetic the planner pages share. The database derives each item's
// status (content_plan_board); this only rolls it up.
// Relative imports (not "@/"), so the unit tests load this file in Node.
import { POST_INTENTS, type PostIntent } from "./social-posts.ts";
import { AGENCY_TIME_ZONE, isUuid, todayIn } from "./tasks.ts";

export const DELIVERABLES = ["social", "gbp", "blog", "web_page"] as const;
export type Deliverable = (typeof DELIVERABLES)[number];
export const isDeliverable = (v: unknown): v is Deliverable => DELIVERABLES.includes(v as Deliverable);

// Per managed client per week. A cadence, not a quota: Authority and quality
// stay the gate, so a slot may stay empty rather than be filled with weak work.
export const WEEKLY_TARGETS: Record<Deliverable, number> = { social: 2, gbp: 2, blog: 2, web_page: 1 };

export const deliverableLabels: Record<Deliverable, { label: string; short: string }> = {
  social: { label: "Social", short: "Social" },
  gbp: { label: "Business Profile", short: "GBP" },
  blog: { label: "Blog", short: "Blogs" },
  web_page: { label: "Web page", short: "Web Pages" },
};

export const SOCIAL_CHANNELS = ["facebook", "instagram", "linkedin", "x", "tiktok"] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

export const PURPOSES = ["authority", "educational", "service", "review", "seasonal_offer", "community_team", "real_work"] as const;
export type Purpose = (typeof PURPOSES)[number];
export const isPurpose = (v: unknown): v is Purpose => PURPOSES.includes(v as Purpose);
export const purposeLabels: Record<Purpose, string> = {
  authority: "Authority",
  educational: "Educational",
  service: "Service",
  review: "Review",
  seasonal_offer: "Seasonal / Offer",
  community_team: "Community / Team",
  real_work: "Real Work / Project",
};

export const PLAN_STATUSES = ["planned", "ready_to_generate", "drafting", "in_review", "approved", "delivered", "blocked"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const planStatusLabels: Record<PlanStatus, { label: string; className: string }> = {
  planned: { label: "Planned", className: "border-slate-200 bg-slate-100 text-slate-700" },
  ready_to_generate: { label: "Ready to generate", className: "border-sky-200 bg-sky-100 text-sky-800" },
  drafting: { label: "Drafting", className: "border-violet-200 bg-violet-100 text-violet-800" },
  in_review: { label: "In review", className: "border-amber-200 bg-amber-100 text-amber-900" },
  approved: { label: "Approved", className: "border-green-200 bg-green-100 text-green-800" },
  delivered: { label: "Delivered", className: "border-emerald-300 bg-emerald-600 text-white" },
  blocked: { label: "Blocked", className: "border-red-200 bg-red-100 text-red-800" },
};
export const isPlanStatus = (v: unknown): v is PlanStatus => PLAN_STATUSES.includes(v as PlanStatus);

// Clients the planner covers: managed now or launching (not paused or offboarded).
export const PLANNER_CLIENT_STATUSES = ["active", "launching"] as const;

// Which Authority content types can fill which slot (mirrors 0064's guard).
export const OPPORTUNITY_DELIVERABLE: Record<string, Deliverable> = {
  gbp_post: "gbp",
  blog_post: "blog",
  blog_refresh: "blog",
  service_page: "web_page",
  location_page: "web_page",
  page_improvement: "web_page",
};

// ── Weeks (Monday to Sunday, Compass's calendar) ─────────────────────────────
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const utc = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function mondayOf(date: string): string {
  const d = utc(date);
  const dow = d.getUTCDay(); // 0 Sunday
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return iso(d);
}
export function addDays(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}
export function currentWeek(now: Date = new Date()): string {
  return mondayOf(todayIn(AGENCY_TIME_ZONE, now));
}
// A ?week= parameter: any date in the week, normalised to its Monday.
export function parseWeek(v: unknown, now: Date = new Date()): string {
  if (typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(utc(v).getTime())) return mondayOf(v);
  return currentWeek(now);
}
export function weekLabel(week: string): string {
  const fmt = (d: string, withYear: boolean) =>
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" }).format(utc(d));
  return `${fmt(week, false)} – ${fmt(addDays(week, 6), true)}`;
}

// ── Roll-up ─────────────────────────────────────────────────────────────────
export type SlotSummary = {
  deliverable: Deliverable;
  target: number;
  planned: number;                         // items, whatever their status
  done: number;                            // approved or delivered
  unplanned: number;                       // target − planned, never below 0
  byStatus: Partial<Record<PlanStatus, number>>;
};

export function summarize(items: { deliverable: string; status: string | null }[]): Record<Deliverable, SlotSummary> {
  const out = {} as Record<Deliverable, SlotSummary>;
  for (const d of DELIVERABLES) {
    const mine = items.filter((i) => i.deliverable === d);
    const byStatus: Partial<Record<PlanStatus, number>> = {};
    for (const i of mine) if (isPlanStatus(i.status)) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    const done = (byStatus.approved ?? 0) + (byStatus.delivered ?? 0);
    out[d] = { deliverable: d, target: WEEKLY_TARGETS[d], planned: mine.length, done, unplanned: Math.max(0, WEEKLY_TARGETS[d] - mine.length), byStatus };
  }
  return out;
}

// ── Form parsing ────────────────────────────────────────────────────────────
export type PlanFields = {
  deliverable: Deliverable;
  channel: string | null;
  purpose: Purpose;
  topic: string;
  search_intent: PostIntent | null;
  service_id: string | null;
  keyword_id: string | null;
  target_url: string | null;
  planned_date: string | null;
  notes: string | null;
};

const opt = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

// Validates what a teammate typed. Authority items are made from their
// opportunity (planFromAuthorityAction), never from this form.
export function parsePlanFields(get: (k: string) => FormDataEntryValue | null, week: string):
  { ok: true; fields: PlanFields } | { ok: false; error: string } {
  const deliverable = opt(get("deliverable"));
  if (!isDeliverable(deliverable)) return { ok: false, error: "Choose what to plan." };
  const purpose = opt(get("purpose"));
  if (!isPurpose(purpose)) return { ok: false, error: "Choose the purpose." };
  if (purpose === "authority") return { ok: false, error: "Authority items are planned from an Authority opportunity (below)." };
  const topic = opt(get("topic"));
  if (!topic) return { ok: false, error: "Say what the piece is about (a topic or keyword)." };
  if (topic.length > 200) return { ok: false, error: "Keep the topic under 200 characters." };
  let channel: string | null = null;
  if (deliverable === "gbp") channel = "google_business";
  if (deliverable === "social") {
    channel = opt(get("channel"));
    if (!SOCIAL_CHANNELS.includes(channel as SocialChannel)) return { ok: false, error: "Choose the social channel." };
  }
  const intent = opt(get("search_intent"));
  if (intent && !POST_INTENTS.includes(intent as PostIntent)) return { ok: false, error: "Unknown search intent." };
  const service = opt(get("service_id"));
  const keyword = opt(get("keyword_id"));
  if ((service && !isUuid(service)) || (keyword && !isUuid(keyword))) return { ok: false, error: "Unknown service or keyword." };
  const target = opt(get("target_url"));
  if (target && !/^https?:\/\/\S+$/.test(target)) return { ok: false, error: "The target page must be a full http(s) URL." };
  const planned = opt(get("planned_date"));
  if (planned && (!ISO_DATE.test(planned) || planned < week || planned > addDays(week, 6))) {
    return { ok: false, error: "The planned date must fall inside this week." };
  }
  const notes = opt(get("notes"));
  return {
    ok: true,
    fields: {
      deliverable, channel, purpose, topic, search_intent: (intent as PostIntent | null) ?? null,
      service_id: service, keyword_id: keyword, target_url: target, planned_date: planned, notes: notes?.slice(0, 2000) ?? null,
    },
  };
}
