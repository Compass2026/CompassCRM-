// Authority decisions (Decisions PR B) as pure rules: which decision an
// opportunity takes, what the engine recommended, the defaults a preview
// starts from, and how authority_apply's answers read. No network, no
// database. authority_apply (0049) is the judge; these rules only shape the
// buttons, the dialogs and the messages.
import type { Opportunity } from "../../supabase/functions/authority/types.ts";

export const AUTHORITY_ONLY = "Authority decision only; no Client Intelligence record created.";
export const MAX_SELECTED = 25;

export type DecisionAction =
  | "keep_intent" | "set_intent" | "approve_market" | "decline_market" | "confirm_service" | "not_offered" | "create_task";
export const DECISION_ACTIONS: readonly DecisionAction[] = [
  "keep_intent", "set_intent", "approve_market", "decline_market", "confirm_service", "not_offered", "create_task",
];
// The ones that change client data (and so start a refresh afterwards).
export const CANONICAL_ACTIONS: readonly DecisionAction[] = ["set_intent", "approve_market", "confirm_service"];

export type DecisionKind = "intent" | "market" | "service" | null;
export function decisionKind(key: string): DecisionKind {
  if (key.startsWith("confirm_intent:")) return "intent";
  if (key.startsWith("confirm_market:")) return "market";
  if (key.startsWith("confirm_service:")) return "service";
  return null;
}

export const INTENTS = ["navigational", "informational", "commercial", "transactional"] as const;

// What the engine said about an intent conflict: the stored intent and the
// intent the query reads as, and which stored values would follow it.
export type IntentRecommendation = { keywordId: string | null; keyword: string | null; stored: string | null; assessed: string; options: string[] };
export function intentRecommendation(o: Pick<Opportunity, "gap" | "target">): IntentRecommendation | null {
  const m = /the query reads as (.+)\.$/.exec(o.gap ?? "");
  if (!m) return null;
  const assessed = m[1];
  const options = assessed === "navigational" ? ["navigational"]
    : assessed === "informational" ? ["informational"]
    : assessed === "commercial or transactional" ? ["commercial", "transactional"] : [];
  return { keywordId: o.target.keyword_id, keyword: o.target.keyword, stored: o.target.intent?.toLowerCase() ?? null, assessed, options };
}

// A market decision's place, as the engine named it.
export function marketPlace(o: Pick<Opportunity, "target" | "topic">): string | null {
  return o.target.location ?? (o.topic.startsWith("Market: ") ? o.topic.slice("Market: ".length) : null);
}

// The engine's place normalisation (authority/urls.ts normPlace), without the padding.
export function normPlace(s: string): string {
  return s.toLowerCase().replace(/['’]/g, "").replace(/\bst\b\.?/g, "saint").replace(/[^a-z0-9]+/g, " ").trim();
}

// A service decision's page and a suggested name from the live page's title.
export function servicePath(key: string): string | null {
  return key.startsWith("confirm_service:") ? key.slice("confirm_service:".length) : null;
}
export function suggestedServiceName(o: Pick<Opportunity, "key" | "reasons">): string {
  const path = servicePath(o.key) ?? "";
  const live = o.reasons.find((r) => r.text.startsWith(`Live page ${path}`));
  const title = live ? /: "(.*)"\.?$/.exec(live.text)?.[1] ?? "" : "";
  const fromTitle = title.split(/\s[|–—-]\s/)[0].trim();
  if (fromTitle) return fromTitle.slice(0, 120);
  const slug = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return slug.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
export function serviceUrl(websiteUrl: string | null, path: string): string | null {
  if (!websiteUrl) return null;
  try { return `${new URL(websiteUrl).origin}${path}`; } catch { return null; }
}

// A task's default title and notes from the opportunity.
export function defaultTask(o: Pick<Opportunity, "topic" | "gap">, actionLabel: string): { title: string; notes: string } {
  return { title: `${actionLabel}: ${o.topic}`.slice(0, 200), notes: o.gap ?? "" };
}

// ── authority_apply's answers ───────────────────────────────────────────────
export const CHANGED_SINCE_PREVIEW = "Changed since the preview, so nothing was saved. Review it again.";

export function applyErrorText(e: { code?: string | null; message?: string | null }): { text: string; changed: boolean } {
  if (e.code === "AU409") return { text: `${e.message?.replace(/\.?$/, ".") ?? CHANGED_SINCE_PREVIEW} Nothing was saved; review it again.`, changed: true };
  if (e.code === "42501") return { text: "Only a signed-in Compass teammate can decide Authority opportunities.", changed: false };
  if (e.code === "P0002") return { text: "This opportunity no longer exists.", changed: true };
  if (e.code === "22023" && e.message) return { text: `${e.message.replace(/\.?$/, ".")} Nothing was saved.`, changed: false };
  return { text: "The decision was not saved (the database gave no clear answer). Reload and check the opportunity's history.", changed: false };
}

export function appliedText(action: DecisionAction, detail: { intent?: string; city?: string; name?: string; title?: string }): string {
  switch (action) {
    case "keep_intent": return "Kept the current intent. It comes back only if a later analysis recommends something different.";
    case "set_intent": return `Intent changed to ${detail.intent}.`;
    case "approve_market": return `${detail.city} approved as a market.`;
    case "decline_market": return `Market declined. ${AUTHORITY_ONLY}`;
    case "confirm_service": return `${detail.name} confirmed as a service.`;
    case "not_offered": return `Marked not offered. ${AUTHORITY_ONLY}`;
    case "create_task": return `Task created: ${detail.title}.`;
  }
}

// What happens after a change to client data: a refresh, unless the site
// snapshot needs a full analysis first.
export type RefreshPlan = { refresh: true } | { refresh: false; text: string };
export function refreshPlan(latest: { inventory_stale: boolean | null; stale_sections: string[] | null } | null): RefreshPlan {
  if (!latest) return { refresh: false, text: "Saved. Run a full analysis to see the effect." };
  if (latest.inventory_stale || (latest.stale_sections ?? []).includes("site")) {
    return { refresh: false, text: "Saved. The site snapshot needs a full analysis before a refresh; run one to see the effect." };
  }
  return { refresh: true };
}
