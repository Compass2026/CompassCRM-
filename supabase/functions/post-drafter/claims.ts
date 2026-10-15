// Binding claims on a drafter's task (20261015180000 for blog drafts,
// 20261015190000 for Authority draft requests): tasks.claimed_by /
// claimed_at, set only by the claim functions. A claim lasts an hour, the
// worker skill's stale rule; the SQL write enforces the same rule.
export const CLAIM_TTL_MS = 60 * 60 * 1000;

export type ClaimHolder = { claimed_by?: string | null; claimed_at?: string | null };

// A live claim by someone else: the holder's label and when it lapses.
export function claimedByOther(holder: ClaimHolder | null, claimant: string | null, now = Date.now()):
  { claimed_by: string; expires_at: string } | null {
  if (!holder?.claimed_by || !holder.claimed_at || holder.claimed_by === claimant) return null;
  const expires = Date.parse(holder.claimed_at) + CLAIM_TTL_MS;
  return expires > now ? { claimed_by: holder.claimed_by, expires_at: new Date(expires).toISOString() } : null;
}

// The caller's `claimant` body field: absent → null; else a 1–80 character label.
export function parseClaimant(v: unknown): { claimant: string | null } | { error: string } {
  if (v == null) return { claimant: null };
  if (typeof v !== "string" || !v.trim() || v.length > 80) return { error: "claimant is a short label for who holds the task" };
  return { claimant: v.trim() };
}
