// The Business Profile publisher as the app shows it (0046): the switch and
// pilot list on app_settings 'publisher', what each publisher_runs outcome
// means, and the channel rules the function itself applies (imported, not
// copied, so the post page and the publisher never disagree).
import type { Json } from "@/lib/database.types";
import { channelProblems, type Snapshot } from "../../supabase/functions/post-publisher/channel.ts";

export { MAX_ATTEMPTS, STUCK_AFTER_MINUTES } from "../../supabase/functions/post-publisher/channel.ts";

export type PublisherSettings = { enabled: boolean; clients: string[] };

export function parsePublisherSettings(value: Json | null | undefined): PublisherSettings {
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const clients = Array.isArray(v.clients) ? v.clients.filter((c): c is string => typeof c === "string") : [];
  return { enabled: v.enabled === true, clients };
}

// What would stop Google from taking the approved content, in the words the
// publisher records. Empty for a post with no approved snapshot yet.
export function approvedChannelProblems(snapshot: Json | null | undefined): string[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  return channelProblems(snapshot as unknown as Snapshot).map((p) => p.message);
}

export const outcomeLabels: Record<string, { label: string; className: string }> = {
  published: { label: "Published", className: "bg-green-100 text-green-800" },
  reconciled: { label: "Found on Google", className: "bg-green-100 text-green-800" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800" },
  blocked: { label: "Blocked", className: "bg-amber-100 text-amber-900" },
  lapsed: { label: "Back to review", className: "bg-amber-100 text-amber-900" },
  retry_scheduled: { label: "Retry scheduled", className: "bg-blue-100 text-blue-800" },
  reminder_opened: { label: "Hand-post task opened", className: "bg-blue-100 text-blue-800" },
  reminder_closed: { label: "Hand-post task closed", className: "bg-muted text-muted-foreground" },
};

export const modeLabels: Record<string, string> = {
  tick: "scheduled run",
  now: "Publish now",
  sweep: "stuck-post check",
  retry: "automatic retry",
  reminder: "reminder",
};

// The Brief's Publishing block: for each post, its latest run, kept when that
// run needs a person: a block, a lapse, or a final failure (not transient, or
// out of attempts — the publisher opened a task for it). A transient failure
// with attempts left is the publisher's to retry. Posts stuck in publishing
// are read from social_posts, not from runs.
export type RunLite = { post_id: string; client_id: string; outcome: string; transient: boolean; detail: string | null; created_at: string; task_id: string | null };

export function needsAttention<T extends RunLite>(latest: T[]): T[] {
  return latest.filter(
    (r) => r.outcome === "blocked" || r.outcome === "lapsed" || (r.outcome === "failed" && (!r.transient || r.task_id !== null))
  );
}

export function latestPerPost<T extends { post_id: string; created_at: string }>(rows: T[]): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const seen = out.get(r.post_id);
    if (!seen || seen.created_at < r.created_at) out.set(r.post_id, r);
  }
  return [...out.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
