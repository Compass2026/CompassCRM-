// The Business Profile publisher as the app shows it (0046): the switch and
// pilot list on app_settings 'publisher', what each publisher_runs outcome
// means, and the channel rules the function itself applies (imported, not
// copied, so the post page and the publisher never disagree).
import type { Json } from "@/lib/database.types";
import { channelProblems, type Snapshot } from "../../supabase/functions/post-publisher/channel.ts";
import { bindingProblems, type Binding } from "../../supabase/functions/post-publisher/facebook.ts";
import { gbpBindingProblems, gbpProblems, gbpRoute, type GbpSnapshot } from "../../supabase/functions/post-publisher/gbp.ts";

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
  uncertain: { label: "Unconfirmed", className: "bg-amber-100 text-amber-900" },
  ambiguous: { label: "Check the profile", className: "bg-red-100 text-red-800" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800" },
  blocked: { label: "Blocked", className: "bg-amber-100 text-amber-900" },
  lapsed: { label: "Back to review", className: "bg-amber-100 text-amber-900" },
  retry_scheduled: { label: "Retry scheduled", className: "bg-blue-100 text-blue-800" },
  reminder_opened: { label: "Hand-post task opened", className: "bg-blue-100 text-blue-800" },
  reminder_closed: { label: "Hand-post task closed", className: "bg-muted text-muted-foreground" },
  submitted: { label: "Sent to Zernio", className: "bg-blue-100 text-blue-800" },
};

// How a run went out (Zernio Social Publisher v1).
export const transportLabels: Record<string, string> = { google: "Google", zernio: "Zernio", manual: "by hand" };

// A Facebook Page's Zernio binding as the app reads it from social_accounts.
export type FacebookBinding = Binding;

// Whether a Facebook post goes out through Zernio: the publisher's switch and
// pilot list, and the Page's own verified, enabled binding of the same
// client. The same rules the publisher applies (facebook.ts), so the post
// page never offers Publish now where the publisher would refuse.
export function zernioRoute(
  post: { platform: string; client_id: string; social_account_id: string | null },
  binding: FacebookBinding | null,
  settings: PublisherSettings,
): { ready: boolean; reasons: string[] } {
  if (post.platform !== "facebook") return { ready: false, reasons: [] };
  const reasons: string[] = [];
  if (!settings.enabled) reasons.push("The publisher is switched off (Settings → Publisher).");
  else if (!settings.clients.includes(post.client_id)) reasons.push("This client is not on the publisher's pilot list (Settings → Publisher).");
  reasons.push(...bindingProblems(post, binding));
  return { ready: reasons.length === 0, reasons };
}

// Business Profile through Zernio: which publisher a Business Profile post
// goes to (exactly one) and, for Zernio, what would stop it — the rules the
// publisher applies (gbp.ts), so the post page shows the same answer.
export function gbpPublishRoute(
  post: { platform: string; client_id: string; review_status: string; social_account_id: string | null; approved_snapshot: unknown },
  destination: Binding | null,
  // The client's explicit transport is zernio (publisher_client_transports),
  // or it has a bound location.
  clientOnZernio: boolean,
  settings: PublisherSettings,
): { via: "zernio" | "google" | null; ready: boolean; reasons: string[] } {
  if (post.platform !== "google_business") return { via: null, ready: false, reasons: [] };
  const snap = (post.review_status === "approved" ? post.approved_snapshot : null) as GbpSnapshot | null;
  const accountId = snap ? snap.social_account_id ?? null : post.social_account_id;
  // Only a Business Profile account names a location (a draft switched from
  // Facebook may still carry its Page).
  const names = !!accountId && (!destination || destination.platform === "google_business");
  const via = gbpRoute(names ? accountId : null, clientOnZernio);
  if (via === "google") return { via, ready: false, reasons: [] };
  const reasons: string[] = [];
  if (!settings.enabled) reasons.push("The publisher is switched off (Settings → Publisher).");
  else if (!settings.clients.includes(post.client_id)) reasons.push("This client is not on the publisher's pilot list (Settings → Publisher).");
  if (snap) reasons.push(...gbpProblems(snap).map((p) => p.message));
  reasons.push(...gbpBindingProblems({ ...post, social_account_id: accountId }, destination));
  return { via, ready: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export const modeLabels: Record<string, string> = {
  tick: "scheduled run",
  now: "Publish now",
  sweep: "stuck-post check",
  retry: "automatic retry",
  reminder: "reminder",
};

// The Brief's Publishing block: for each post, its latest run, kept when that
// run needs a person: a block, a lapse, an ambiguous check (the publisher
// will not re-send or record it on its own), or a final failure (not
// transient, or out of attempts — the publisher opened a task for it). A
// transient failure with attempts left is the publisher's to retry, and an
// uncertain answer is its to check. Posts stuck in publishing are read from
// social_posts, not from runs.
export type RunLite = { post_id: string; client_id: string; outcome: string; transient: boolean; detail: string | null; created_at: string; task_id: string | null };

export function needsAttention<T extends RunLite>(latest: T[]): T[] {
  return latest.filter(
    (r) => r.outcome === "blocked" || r.outcome === "lapsed" || r.outcome === "ambiguous" || (r.outcome === "failed" && (!r.transient || r.task_id !== null))
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
