// The Authority opportunity lifecycle as the tab shows it: the status chip,
// which lifecycle actions a card offers (and why one is unavailable), the
// dismissal end dates and the history lines. Pure: no network, no database.
//
// authority_decide (0048) is the only writer and stays the judge: it refuses
// a dismissal without a reason or a future date, a dismissal while linked
// work is open, and every transition from the wrong state. These rules only
// keep the menu honest; every refusal it can give is still mapped.
import { todayIn } from "./tasks.ts";

export const DISMISS_DAYS = [30, 60, 90] as const;
export type DismissDays = (typeof DISMISS_DAYS)[number];
export const REASON_MAX = 500;

export type StoredStatus = "open" | "accepted" | "dismissed";
export type EffectiveStatus = "open" | "accepted" | "in_progress" | "completed" | "dismissed" | "resolved";
export type Verb = "accept" | "release" | "dismiss" | "suppress" | "reopen";
export const VERBS: readonly Verb[] = ["accept", "release", "dismiss", "suppress", "reopen"];

// The stored workflow, as the page read it. Sent back with every action so a
// second tab or a double click cannot act on a state it did not see.
export type WorkflowSnapshot = { status: StoredStatus; suppressed: boolean; dismissed_until: string | null };

export type Workflow = WorkflowSnapshot & {
  opportunityId: string;
  effective: EffectiveStatus;
  reason: string | null;
  decidedBy: string | null;   // a teammate's name
  decidedAt: string | null;   // ISO
  keptIntent?: { stored: string; assessed: string } | null; // a suppression bound to the reviewed recommendation (0049)
};

// ── Dates (the agency's calendar, America/Chicago) ──────────────────────────
export const agencyToday = (now: Date): string => todayIn(undefined, now);
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// The end date of a 30 / 60 / 90-day dismissal made now.
export function dismissUntil(days: DismissDays, now: Date): string {
  return addDays(agencyToday(now), days);
}
export function formatDay(day: string | null | undefined): string {
  if (!day) return "—";
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
}

// ── The chip ────────────────────────────────────────────────────────────────
export type Chip = { label: string; tone: "blue" | "amber" | "green" | "slate" | "muted"; title?: string };

export function statusChip(w: Workflow | null): Chip | null {
  if (!w) return null;
  switch (w.effective) {
    case "accepted": return { label: "Accepted", tone: "blue" };
    case "in_progress": return { label: "In progress", tone: "blue", title: "Linked work is open." };
    case "completed": return { label: "Completed", tone: "green", title: "Linked work is done." };
    case "resolved": return { label: "Resolved", tone: "green" };
    case "dismissed":
      if (w.suppressed && w.keptIntent) {
        return { label: `Intent kept: ${w.keptIntent.stored}`, tone: "slate", title: `Returns if the analysis stops reading it as ${w.keptIntent.assessed}.` };
      }
      return w.suppressed
        ? { label: "Never recommend", tone: "slate", title: w.reason ?? undefined }
        : { label: `Dismissed until ${formatDay(w.dismissed_until)}`, tone: "amber", title: w.reason ?? undefined };
    case "open":
      // A dismissal whose date has passed reads as open until the next run records the reopening.
      return w.status === "dismissed" ? { label: `Dismissal ended ${formatDay(w.dismissed_until)}`, tone: "muted" } : null;
    default: return null;
  }
}

// ── The menu ────────────────────────────────────────────────────────────────
export type MenuItem = {
  id: string;                    // accept | release | dismiss-30 | dismiss-60 | dismiss-90 | suppress | reopen
  verb: Verb;
  days?: DismissDays;
  label: string;
  enabled: boolean;
  reason: string | null;         // why it is unavailable
  dialog: boolean;               // asks for a reason (and confirms) first
};

const WORK_OPEN = "Work is linked and still open; finish or close it first.";

function dismissItems(enabled: boolean, reason: string | null): MenuItem[] {
  return [
    ...DISMISS_DAYS.map((d): MenuItem => ({ id: `dismiss-${d}`, verb: "dismiss", days: d, label: `Dismiss for ${d} days…`, enabled, reason, dialog: true })),
    { id: "suppress", verb: "suppress", label: "Never recommend again…", enabled, reason, dialog: true },
  ];
}

export function lifecycleMenu(w: Workflow | null): MenuItem[] {
  if (!w) return [];
  const item = (verb: Verb, label: string): MenuItem => ({ id: verb, verb, label, enabled: true, reason: null, dialog: false });
  switch (w.effective) {
    case "open":
      return w.status === "dismissed"
        ? [item("reopen", "Reopen"), ...dismissItems(true, null)]
        : [item("accept", "Accept"), ...dismissItems(true, null)];
    case "accepted":
      return [item("release", "Release (back to open)"), ...dismissItems(true, null)];
    case "in_progress":
      return dismissItems(false, WORK_OPEN);
    case "dismissed":
      return [item("reopen", "Reopen")];
    default:
      return []; // completed or resolved: nothing to decide
  }
}

// ── Validation (the server action's, before authority_decide) ──────────────
export type DecideInput = { verb: Verb; days?: number; reason?: string; expected: WorkflowSnapshot };
export type DecidePlan = { verb: Verb; payload: Record<string, string> } | { error: string };

export function planDecision(input: DecideInput, now: Date): DecidePlan {
  if (!VERBS.includes(input.verb)) return { error: "Unknown action." };
  const reason = (input.reason ?? "").trim();
  if (input.verb === "dismiss" || input.verb === "suppress") {
    if (!reason) return { error: "A reason is required." };
    if (reason.length > REASON_MAX) return { error: `Keep the reason under ${REASON_MAX} characters.` };
  }
  if (input.verb === "dismiss") {
    if (!DISMISS_DAYS.includes(input.days as DismissDays)) return { error: "Choose 30, 60 or 90 days." };
    return { verb: "dismiss", payload: { reason, until: dismissUntil(input.days as DismissDays, now) } };
  }
  if (input.verb === "suppress") return { verb: "suppress", payload: { reason } };
  return { verb: input.verb, payload: {} };
}

export function sameSnapshot(a: WorkflowSnapshot, b: WorkflowSnapshot): boolean {
  return a.status === b.status && a.suppressed === b.suppressed && (a.dismissed_until ?? null) === (b.dismissed_until ?? null);
}

export const CHANGED_SINCE_LOADED = "This opportunity changed since the page loaded (another tab or teammate). The page now shows its current state.";

// authority_decide's refusals, as the person should read them.
export function decideErrorText(e: { code?: string | null; message?: string | null }): string {
  if (e.code === "42501") return "Only a signed-in Compass teammate can decide Authority opportunities.";
  if (e.code === "P0002") return "This opportunity no longer exists.";
  if (e.code === "22023" && e.message) return `${e.message.replace(/\.?$/, ".")}`;
  return "The decision was not saved (the database gave no clear answer). Reload and check the opportunity's history.";
}

export function doneText(verb: Verb, payload: Record<string, string>): string {
  switch (verb) {
    case "accept": return "Accepted.";
    case "release": return "Released: back to open.";
    case "dismiss": return `Dismissed until ${formatDay(payload.until)}.`;
    case "suppress": return "Won't be recommended again. Reopen it from the Dismissed group.";
    case "reopen": return "Reopened.";
  }
}

// ── History (Details) ───────────────────────────────────────────────────────
export type EventRow = {
  opportunity_id: string; run_id: string | null; created_at: string; kind: string; actor_kind: string;
  actor_id?: string | null; detail?: Record<string, unknown> | null;
};
export type HistoryLine = { at: string; kind: string; text: string; actor: string };

const KIND_TEXT: Record<string, string> = {
  created: "First reported", section_changed: "Moved section", resolved: "Resolved (no longer reported)", regressed: "Reported again",
  reopened: "Reopened", accepted: "Accepted", released: "Released", dismissed: "Dismissed", suppressed: "Never recommend again",
  linked: "Work linked", decision: "Decision",
};

export function historyLine(e: EventRow, members: { id: string; name: string | null; email: string }[]): HistoryLine {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const person = e.actor_id ? members.find((m) => m.id === e.actor_id) : null;
  const actor = e.actor_kind === "team" ? (person ? person.name ?? person.email : "teammate") : e.actor_kind;
  const parts = [KIND_TEXT[e.kind] ?? e.kind];
  if (e.kind === "dismissed" && s("until")) parts.push(`until ${formatDay(s("until"))}`);
  const section = (k: string) => { const v = d[k] as { section?: unknown } | undefined; return typeof v?.section === "string" ? v.section.replace(/_/g, " ") : null; };
  if (e.kind === "section_changed" && section("from") && section("to")) parts.push(`${section("from")} → ${section("to")}`);
  if (e.kind === "linked" && s("kind")) parts.push(`(${s("kind")!.replace(/_/g, " ")})`);
  if (e.kind === "decision" && s("decision")) parts.push(`: ${s("decision")}`);
  let text = parts.join(" ");
  if (s("reason") && (e.kind === "dismissed" || e.kind === "suppressed" || e.kind === "reopened")) text += ` — “${s("reason")}”`;
  return { at: e.created_at, kind: e.kind, text, actor };
}
