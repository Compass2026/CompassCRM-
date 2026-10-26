// Rejection corrections (20261026200000, docs/post-revisions.md): how a
// revision request reads on the post page. Pure: the database decides every
// state; this only labels it honestly (queued is not working, working is not
// done, and nothing here says an assistant was woken).

export const REVISION_CATEGORIES = ["copy", "creative", "both"] as const;
export type RevisionCategory = (typeof REVISION_CATEGORIES)[number];

// What the reviewer rejected, in the words the review form uses. The stored
// value "creative" covers an attached image as well as a rendered graphic.
export const categoryLabels: Record<RevisionCategory, string> = {
  copy: "Caption",
  creative: "Image",
  both: "Caption and image",
};

export type ObligationState = "not_needed" | "queued" | "working" | "blocked" | "manual" | "ready" | "resolved";

export type RevisionRequest = {
  id: string;
  status: string;
  mode: string;
  category: string;
  original_category: string;
  feedback: string;
  rejected_by: string | null;
  rejected_at: string;
  legacy: boolean;
  copy_state: string;
  copy_detail: string | null;
  image_state: string;
  image_assignee: string;
  image_detail: string | null;
  task_id: string | null;
};

export type RevisionEvent = {
  id: number;
  kind: string;
  obligation: string | null;
  actor_kind: string;
  actor_id: string | null;
  detail: unknown;
  created_at: string;
};

const tone = {
  waiting: "border-amber-200 bg-amber-50 text-amber-900",
  working: "border-blue-200 bg-blue-50 text-blue-900",
  bad: "border-red-200 bg-red-50 text-red-800",
  done: "border-green-200 bg-green-50 text-green-800",
  quiet: "border-slate-200 bg-slate-50 text-slate-700",
};

export const requestStatusLabels: Record<string, { label: string; className: string }> = {
  open: { label: "Correction open", className: tone.waiting },
  returned: { label: "Corrected: back in review", className: tone.done },
  accepted: { label: "Approved after correction", className: tone.done },
  superseded: { label: "Superseded by a later rejection", className: tone.quiet },
};

function who(obligation: "copy" | "image", r: Pick<RevisionRequest, "image_assignee">): string {
  if (obligation === "copy") return "Claude";
  return r.image_assignee === "creative_engine" ? "a teammate (Creative Engine)" : "ChatGPT";
}

// One obligation's state as a person should read it.
export function obligationLabel(
  obligation: "copy" | "image",
  state: string,
  r: Pick<RevisionRequest, "image_assignee" | "mode">,
): { label: string; className: string } {
  const by = who(obligation, r);
  switch (state) {
    case "not_needed": return { label: "Not rejected", className: tone.quiet };
    case "queued":
      return obligation === "image" && r.image_assignee === "chatgpt"
        ? { label: "Queued for ChatGPT", className: tone.waiting }
        : obligation === "image"
          ? { label: "Waiting for a teammate to re-render", className: tone.waiting }
          : { label: "Queued for Claude", className: tone.waiting };
    case "working": return { label: `${by[0].toUpperCase()}${by.slice(1)} is working on it`, className: tone.working };
    case "blocked": return { label: "Blocked", className: tone.bad };
    case "manual": return { label: "Manual: a teammate edits it", className: tone.quiet };
    case "ready": return { label: "Corrected", className: tone.done };
    case "resolved": return { label: "No change needed (recorded)", className: tone.done };
    default: return { label: state, className: "" };
  }
}

// Whether the review form offers the category choice: any media at all
// (an attached image as well as a rendered graphic) can be rejected.
export function canRejectImage(mediaCount: number): boolean {
  return mediaCount > 0;
}

// The actions a teammate has on a request, given the post's review state.
export type RevisionAction = "reclassify" | "request_correction" | "reopen_manual" | "resolve_copy" | "resolve_image";

export function revisionActions(r: Pick<RevisionRequest, "status" | "mode" | "copy_state" | "image_state">, reviewStatus: string): RevisionAction[] {
  if (r.status !== "open") return [];
  const out: RevisionAction[] = ["reclassify"];
  const unmet = (s: string) => ["queued", "working", "blocked", "manual"].includes(s);
  const editable = reviewStatus === "rejected" || reviewStatus === "draft";
  // Request (or retry) the automatic correction: also when it is queued, since
  // a queued item may never have been picked up.
  if (editable && (unmet(r.copy_state) || unmet(r.image_state))) out.push("request_correction");
  if (r.mode === "automatic" && (reviewStatus === "rejected" || reviewStatus === "draft")) out.push("reopen_manual");
  if (unmet(r.copy_state)) out.push("resolve_copy");
  if (unmet(r.image_state)) out.push("resolve_image");
  return out;
}

// The request's history, one line each, with the dispatch evidence a person
// needs to judge it (the worker fire, the outbox item and its receipt).
export function describeRevisionEvent(e: RevisionEvent, names: Map<string, string>): string {
  const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, unknown>;
  const actor =
    e.actor_kind === "team" ? (e.actor_id && names.get(e.actor_id)) || "A teammate"
      : e.actor_kind === "drafter" ? "Claude (AI Drafter)"
        : e.actor_kind === "assistant" ? (typeof (d.edit as Record<string, unknown> | undefined)?.executed_by === "string"
            ? String((d.edit as Record<string, unknown>).executed_by) : "An assistant")
          : e.actor_kind === "system" ? "System" : e.actor_kind === "worker" ? "Worker" : e.actor_kind;
  const part = e.obligation === "copy" ? "caption" : e.obligation === "image" ? "image" : null;
  switch (e.kind) {
    case "created": return d.legacy ? "Recovered from the last rejection (no work was started)" : `${actor}: rejected it; correction requested`;
    case "dispatched":
      return d.debounced ? "Caption: the worker was already started in the last two minutes"
        : `Caption: the worker Routine was started (fire ${String(d.worker_fire_id ?? "?")})`;
    case "dispatch_unconfigured": return "Caption: the worker Routine is not configured; nothing was started";
    case "queued": return `Image: queued for ChatGPT (outbox generation ${String(d.generation ?? 1)})`;
    case "delivered": {
      const rc = (d.receipt ?? {}) as Record<string, unknown>;
      return `Image: Executive OS picked it up for ChatGPT (receipt ${String(rc.id ?? "?")})`;
    }
    case "claimed": return `Caption: ${String(d.claimant ?? "the worker")} claimed it`;
    case "blocked": return `Caption blocked (${String(d.code ?? "blocked")}): ${String(d.message ?? "")}`;
    case "revised": return `${actor}: corrected the ${part ?? "post"}`;
    case "resolved": return d.backfill ? "Changed after the rejection, before revision tracking (backfill)"
      : `${actor}: recorded that the ${part} needs no change — “${String(d.note ?? "")}”`;
    case "reclassified": return `${actor}: corrected what was rejected from ${label(d.from)} to ${label(d.to)} — “${String(d.note ?? "")}”`;
    case "manual": return `${actor}: reopened it to edit by hand (automatic correction stopped)`;
    case "automatic": return `${actor}: requested automatic correction`;
    case "resubmit_refused": return `Could not go back to review: ${String(d.message ?? "")}`;
    case "returned": return "Every rejected part corrected: back in review for a fresh approval";
    case "reopened": return "Withdrawn from review again; the feedback stays open";
    case "accepted": return "Approved";
    case "superseded": return "Superseded by a later rejection";
    default: return e.kind;
  }
}

function label(v: unknown): string {
  return typeof v === "string" && v in categoryLabels ? categoryLabels[v as RevisionCategory].toLowerCase() : String(v ?? "?");
}
