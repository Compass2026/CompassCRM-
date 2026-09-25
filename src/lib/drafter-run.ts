// What the post page shows about an AI-drafted post (0047's drafter_runs row
// next to the post as it is now). Pure; the page computes the copy's sha256.

export type DrafterRunRow = {
  id: string;
  created_at: string;
  runtime: string;
  attempt: number;
  status: string;
  requested_via: string;
  brief_version: string;
  brief_hash: string;
  copy_hash: string | null;
  claim_ids: string[];
  lint: unknown;
  target: unknown;
};

export type DrafterSummary = {
  runtime: string;
  attempt: number;
  requestedVia: string;
  lintPassed: boolean;
  warnings: { code: string; message: string }[];
  briefVersion: string;
  briefHash: string;
  briefHashShort: string;
  targetPage: string | null;
  claimCount: number;
  // What a person changed after the linter passed it (copy, claims, button).
  editedAfterCheck: string[];
};

type PostNow = { copy: string | null; cta_url: string | null; linkedClaimIds: string[]; copyHash: string };

export function drafterSummary(run: DrafterRunRow, post: PostNow): DrafterSummary {
  const lint = (run.lint ?? {}) as { ok?: boolean; warnings?: { code: string; message: string }[] };
  const target = (run.target ?? {}) as { service?: { page_url?: string | null } | null; cta?: { url?: string | null } | null };
  const edited: string[] = [];
  if (run.copy_hash && run.copy_hash !== post.copyHash) edited.push("copy");
  const was = [...run.claim_ids].sort().join(",");
  const now = [...post.linkedClaimIds].sort().join(",");
  if (was !== now) edited.push("claims");
  if ((target.cta?.url ?? null) !== (post.cta_url ?? null)) edited.push("button");
  return {
    runtime: run.runtime,
    attempt: run.attempt,
    requestedVia: run.requested_via,
    lintPassed: lint.ok === true,
    warnings: Array.isArray(lint.warnings) ? lint.warnings : [],
    briefVersion: run.brief_version,
    briefHash: run.brief_hash,
    briefHashShort: run.brief_hash.replace(/^sha256:/, "").slice(0, 12),
    targetPage: target.service?.page_url ?? target.cta?.url ?? null,
    claimCount: run.claim_ids.length,
    editedAfterCheck: edited,
  };
}
