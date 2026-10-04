// Authority plans within the agreement (B5). The engine's analysis stays what
// it is — facts about the site and the CRM, fingerprinted and deterministic —
// and never reads entitlements or billing. What the agreement allows is
// applied here, to the work each opportunity would create: a kind of work the
// agreement does not include is marked "Not in agreement", and one whose
// monthly allocation is used is marked "Allocation used". Nothing is hidden
// or removed, and a teammate may still act on any card (people keep
// operational control); the marks are what automation follows.

import {
  planWork,
  type EntitlementSet,
  type PlanDecision,
  type QuotaKey,
  type QuotaUsage,
  type WorkKind,
} from "./entitlements.ts";

export type AgreementContext =
  | { set: EntitlementSet; usage: Partial<Record<QuotaKey, Pick<QuotaUsage, "used">>> }
  | { unavailable: string };

export type CardAgreement = {
  kind: WorkKind;
  status: PlanDecision["status"] | "unknown";
  label: string | null;                    // shown only when the work is not planned automatically
  title: string;
};

// The work an opportunity would create, if any. CRM data fixes, decisions,
// research and consolidation are Compass's own housekeeping, not agreed
// deliverables, so they carry no agreement mark.
export function workKindOf(o: { action: string; content_type: string }): WorkKind | null {
  if (o.action === "create") {
    if (o.content_type === "gbp_post") return "gbp_post";
    if (o.content_type === "blog_post") return "blog_post";
    if (o.content_type === "service_page" || o.content_type === "location_page") return "new_page";
    return null;
  }
  if (o.action === "refresh") return "page_refresh";
  if (o.action === "improve" && o.content_type === "page_improvement") return "page_refresh";
  return null;
}

const KIND_NAMES: Record<WorkKind, string> = {
  gbp_post: "Business Profile posts",
  social_post: "social posts",
  blog_post: "blog posts",
  new_page: "new website pages",
  page_refresh: "page refreshes",
};

export function cardAgreement(o: { action: string; content_type: string }, ctx: AgreementContext | null | undefined): CardAgreement | null {
  const kind = workKindOf(o);
  if (!kind || !ctx) return null;
  if ("unavailable" in ctx) {
    return { kind, status: "unknown", label: "Agreement unknown", title: `The client's entitlements could not be read (${ctx.unavailable}); automatic planning is paused.` };
  }
  const d = planWork(ctx.set, ctx.usage, kind, 1);
  const name = KIND_NAMES[kind];
  if (d.status === "not_in_agreement") {
    return { kind, status: d.status, label: "Not in agreement", title: `The agreement does not include ${name}. Automation will not plan this; a teammate still may.` };
  }
  if (d.status === "allocation_used") {
    return { kind, status: d.status, label: "Allocation used", title: `${d.used} of ${d.allocation} ${name} this month are planned or done. Automation waits for next month; a teammate may still add it.` };
  }
  return { kind, status: d.status, label: null, title: `${d.remaining} of ${d.allocation} ${name} left this month.` };
}
