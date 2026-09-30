// Reporting keeps what Compass delivered (actual) and what the agreement
// includes (included) apart (B5). Actual comes from the work records —
// published Compass blog posts, published social posts, published Business
// Profile posts (GBP is its own quota, never counted as social). Included
// comes from the entitlement contract. Neither is derived from the other and
// neither from billing; comparing them is the reader's job.
//
// Included is the agreement as it stands now: agreements are not versioned,
// so an earlier month shows today's terms (client_agreement_events holds the
// history of changes). See docs/billing.md, "Agreement versioning".

import { monthlyAllocation, type EntitlementSet } from "./entitlements.ts";

export type ActivityCounts = { blog: number; social: number; gbp: number };
export type MonthActivity = { month: string; actual: ActivityCounts; included: ActivityCounts | null };

type Dated = { published_at: string | null };

export function actualInMonth(
  month: string,                           // yyyy-mm or yyyy-mm-dd
  blogPosts: Dated[],
  socialPosts: (Dated & { platform: string })[],
): ActivityCounts {
  const prefix = month.slice(0, 7);
  const inMonth = (d: string | null) => !!d && d.startsWith(prefix);
  return {
    blog: blogPosts.filter((p) => inMonth(p.published_at)).length,
    social: socialPosts.filter((p) => p.platform !== "google_business" && inMonth(p.published_at)).length,
    gbp: socialPosts.filter((p) => p.platform === "google_business" && inMonth(p.published_at)).length,
  };
}

export function includedPerMonth(set: EntitlementSet | null): ActivityCounts | null {
  if (!set) return null;
  return {
    blog: monthlyAllocation(set, "blog_posts"),
    social: monthlyAllocation(set, "social_posts"),
    gbp: monthlyAllocation(set, "gbp_posts"),
  };
}

export function monthActivity(month: string, blogPosts: Dated[], socialPosts: (Dated & { platform: string })[], set: EntitlementSet | null): MonthActivity {
  return { month: month.slice(0, 7), actual: actualInMonth(month, blogPosts, socialPosts), included: includedPerMonth(set) };
}

export function actualText(a: ActivityCounts): string {
  return `${a.blog} blog · ${a.social} social · ${a.gbp} Business Profile published`;
}

export function includedText(i: ActivityCounts | null): string {
  if (!i) return "Included: unknown (entitlements could not be read)";
  const parts = [
    i.blog > 0 && `${i.blog} blog`,
    i.social > 0 && `${i.social} social`,
    i.gbp > 0 && `${i.gbp} Business Profile`,
  ].filter(Boolean);
  return parts.length ? `Included each month: ${parts.join(" · ")} posts` : "Included each month: no posts in the agreement";
}
