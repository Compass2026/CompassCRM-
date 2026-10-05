// A post's creative in the CRM (0054): its policy, its status and what a
// teammate may do with it. The database enforces every rule here again; these
// only decide what the post page offers.

export const CREATIVE_POLICIES = ["none", "optional", "required"] as const;
export type CreativePolicy = (typeof CREATIVE_POLICIES)[number];
export const isCreativePolicy = (v: unknown): v is CreativePolicy => CREATIVE_POLICIES.includes(v as CreativePolicy);

export const policyLabels: Record<CreativePolicy, { label: string; help: string }> = {
  none: { label: "No graphic", help: "The post goes out as text (or with a linked photo)." },
  optional: { label: "Graphic optional", help: "A graphic may be rendered; the post can be approved without one." },
  required: { label: "Graphic required", help: "The post cannot be approved until a rendered graphic is linked." },
};

export const creativeStatusLabels: Record<string, { label: string; className: string }> = {
  none: { label: "no graphic", className: "" },
  needed: { label: "graphic needed", className: "border-amber-200 bg-amber-100 text-amber-900" },
  requested: { label: "new graphic requested", className: "border-amber-200 bg-amber-100 text-amber-900" },
  rendering: { label: "rendering", className: "border-blue-200 bg-blue-100 text-blue-800" },
  ready: { label: "graphic ready", className: "border-green-200 bg-green-100 text-green-800" },
  failed: { label: "render failed", className: "border-red-200 bg-red-100 text-red-800" },
};

export const REJECTION_CATEGORIES = ["copy", "creative", "both"] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];
export const rejectionLabels: Record<RejectionCategory, string> = {
  copy: "The copy",
  creative: "The graphic",
  both: "Both",
};

type PostState = {
  review_status: string;
  publish_status: string;
  creative_policy: string;
  rejection_category: string | null;
};

// "Request new creative" (request_new_creative): keeps the copy, unlinks the
// graphic and returns the post to draft. Not for a published post, and not
// when the copy itself was rejected (that needs a new draft).
export function canRequestNewCreative(p: PostState): boolean {
  if (p.creative_policy === "none") return false;
  if (p.publish_status === "publishing" || p.publish_status === "published") return false;
  if (p.review_status === "in_review" || p.review_status === "approved") return true;
  return p.review_status === "rejected" && p.rejection_category === "creative";
}

// Render or change the policy: only a draft.
export const canRenderCreative = (p: PostState) => p.review_status === "draft" && p.creative_policy !== "none";

// The download name: client, template and the first 12 hex of the content
// hash, so a downloaded file still says exactly which bytes it is.
export function creativeFileName(clientName: string, templateKey: string | null, contentHash: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug(clientName) || "client"}-${templateKey ? slug(templateKey) : "creative"}-${contentHash.slice(0, 12)}.png`;
}
