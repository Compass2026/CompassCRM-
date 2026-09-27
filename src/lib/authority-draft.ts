// Draft with AI on the Authority tab (0053 + post-drafter v2). Pure.
//
// What a Ready Business Profile post card shows about its AI draft: the
// button, the open request (with a restart for a start that failed or never
// happened), the linked post in review, or the approved post that completed
// this cadence cycle. The request task is orchestration only; the linked
// post decides the lifecycle (in review → in progress, approved → completed,
// rejected → draftable again).

export type DraftRequest = { id: string; status: "open" | "in_progress" | "blocked"; notes: string | null; createdAt: string };
export type DraftPost = { id: string; reviewStatus: string; publishStatus: string; linkedAt: string };
export type DraftInfo = { request: DraftRequest | null; posts: DraftPost[]; cycleStartedAt: string | null };

export type DraftControl =
  | { state: "available"; label: string; runId: string }
  | { state: "requested"; label: string; detail: string; taskId: string }
  | { state: "blocked"; label: string; detail: string; taskId: string; runId: string }
  | { state: "in_review"; label: string; postId: string }
  | { state: "completed"; label: string; postId: string }
  | { state: "waiting"; label: string; detail: string };

type Opp = { content_type: string; section: string; action: string; eligible_from: string | null };

// The last note line a blocked request carries (the worker writes the
// conflict or refusal there).
function lastNote(notes: string | null): string {
  const lines = (notes ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "The worker stopped without a reason.";
}

// runId: the analysis run the page shows (the request is refused if a newer one exists).
export function draftControl(o: Opp, workflowStatus: string | null, info: DraftInfo | undefined, today: string, runId: string): DraftControl | null {
  if (o.content_type !== "gbp_post" || o.section !== "ready" || o.action !== "create") return null;
  if (workflowStatus === "dismissed") return null;
  const cycle = info?.cycleStartedAt ? new Date(info.cycleStartedAt).getTime() : -Infinity;
  const inCycle = (info?.posts ?? []).filter((p) => new Date(p.linkedAt).getTime() >= cycle)
    .sort((a, b) => b.linkedAt.localeCompare(a.linkedAt));
  const done = inCycle.find((p) => p.reviewStatus === "approved" || p.publishStatus === "published");
  if (done) return { state: "completed", label: "Approved post · completed this cycle", postId: done.id };
  const active = inCycle.find((p) => p.reviewStatus === "draft" || p.reviewStatus === "in_review");
  if (active) return { state: "in_review", label: "AI draft in review", postId: active.id };
  const r = info?.request;
  if (r && (r.status === "open" || r.status === "in_progress")) {
    return {
      state: "requested", taskId: r.id,
      label: r.status === "in_progress" ? "AI draft being written" : "AI draft requested",
      detail: "The worker drafts it through the AI Drafter; the draft stops in review. If nothing appears, restart the request.",
    };
  }
  if (o.eligible_from && o.eligible_from > today) {
    return { state: "waiting", label: "Not yet due", detail: `The next post for this service and intent is due ${o.eligible_from}.` };
  }
  if (r && r.status === "blocked") {
    return { state: "blocked", taskId: r.id, runId, label: "The last AI draft request stopped", detail: lastNote(r.notes) };
  }
  return { state: "available", label: "Draft with AI", runId };
}
