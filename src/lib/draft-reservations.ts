// Who holds a draft request (20261018220000): Reserve for on Generate draft
// and, since 20261018230000, on Regenerate; and the binding claim on the request task (20261015175146). The database
// checks every rule again; this decides what the form offers and how the
// Planner and the draft page say who holds it.

// The hour every writer honours (content_draft_claim, content_draft_write,
// content-drafter, post-drafter).
export const CLAIM_MS = 60 * 60_000;

export const ROUTINE_LABEL = "worker-routine";

// Reserve for choices on the Generate draft and Regenerate forms. Empty is the Routine.
export const RESERVE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Worker Routine (starts now)" },
  { value: "claude-operator", label: "Claude operator session (claude-operator)" },
];

// The database's rule, word for word (both migrations).
export const LABEL = /^[a-z0-9][a-z0-9-]{1,39}$/;

// The form's value → the RPC's p_reserve_for. Empty → undefined (the Routine).
export function parseReserveFor(raw: unknown): { value?: string; error?: string } {
  const v = String(raw ?? "").trim();
  if (!v) return {};
  if (v === ROUTINE_LABEL) return {};
  if (!LABEL.test(v)) return { error: "Reserve for takes a short label: lowercase letters, digits and dashes (e.g. claude-operator)." };
  return { value: v };
}

export type ClaimHolder = { claimed_by?: string | null; claimed_at?: string | null };

// A live hold: who and until when, or null when unclaimed or over an hour old.
export function liveHold(holder: ClaimHolder | null | undefined, now: number = Date.now()): { by: string; until: string } | null {
  if (!holder?.claimed_by || !holder.claimed_at) return null;
  const until = Date.parse(holder.claimed_at) + CLAIM_MS;
  if (!Number.isFinite(until) || until <= now) return null;
  return { by: holder.claimed_by, until: new Date(until).toISOString() };
}

export const isRoutine = (by: string) => by === ROUTINE_LABEL;

// content_draft_request's CD409 ("claimed_by_other: X holds this request
// until T") in a teammate's words; other messages pass through.
export function reserveError(message: string, format: (iso: string) => string): string {
  const m = /claimed_by_other: (\S+) holds this request until (.+)$/.exec(message);
  if (!m) return message;
  const t = Date.parse(m[2].replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return `${m[1]} already holds this request${Number.isFinite(t) ? ` until ${format(new Date(t).toISOString())}` : ""}. Wait for it, or leave Reserve for on the Routine.`;
}

// What a reserved request or regenerate answers ({reserved_for, expires_at})
// in a teammate's words; null when nothing was reserved (the Routine).
export function reservedText(data: unknown, format: (iso: string) => string): string | null {
  const held = data as { reserved_for?: unknown; expires_at?: unknown } | null;
  if (!held || typeof held.reserved_for !== "string" || !held.reserved_for) return null;
  const until = typeof held.expires_at === "string" && held.expires_at ? ` until ${format(held.expires_at)}` : "";
  return `Reserved for ${held.reserved_for}${until}. The worker Routine was not started.`;
}
