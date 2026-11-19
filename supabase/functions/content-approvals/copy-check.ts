// The copy check for delegated copy edits (20261029180000): the post-drafter's
// own brief and linter, applied to the post as it stands (its channel, type,
// intent, service, keyword, CTA, offer, media and destination) with the copy
// and claims the assistant proposes. Nothing here writes; the brief is
// rebuilt from live Client Intelligence, never handed in.
import { buildBrief, briefHash } from "../post-drafter/brief.ts";
import { lintDraft } from "../post-drafter/lint.ts";
import { workspaceAccounts } from "../post-drafter/workspace.ts";
import type { DraftTarget, DrafterInput, LintProblem, SocialAccountRow } from "../post-drafter/types.ts";

// The post's target, read from the post (and, for a drafted post, the
// campaign mode its run recorded).
export type PostTarget = {
  platform: string;
  post_type: "standard" | "offer";
  search_intent: string;
  service_id: string | null;
  keyword_id: string | null;
  offer_id: string | null;
  cta_type: string | null;
  cta_url: string | null;
  social_account_id: string | null;
  asset_ids: string[];
  campaign_mode: "keyword" | "non_search" | null;
};

export type CopyCheckDeps = {
  postTarget(clientId: string, postId: string): Promise<PostTarget | null>;
  input(clientId: string, serviceId: string | null, keywordId: string | null): Promise<DrafterInput | null>;
  socialAccounts(clientId: string): Promise<SocialAccountRow[]>;
  gazetteer?: Record<string, string[]>;
};

export type CopyCheckResult =
  | { ok: true; brief_hash: string; warnings: LintProblem[] }
  | { ok: false; code: "post_not_found" | "brief_refused" | "lint_failed"; message: string; problems: LintProblem[] };

export function targetOf(p: PostTarget): DraftTarget {
  return {
    channel: p.platform,
    postType: p.post_type,
    intent: p.search_intent,
    campaignMode: p.campaign_mode ?? (p.keyword_id ? "keyword" : "non_search"),
    serviceId: p.service_id,
    keywordId: p.keyword_id,
    ctaType: p.cta_type,
    ctaUrl: p.cta_url,
    offerId: p.offer_id,
    assetIds: p.asset_ids,
    ...(p.social_account_id ? { socialAccountId: p.social_account_id } : {}),
  };
}

export function createCopyCheck(deps: CopyCheckDeps) {
  return async function check(clientId: string, postId: string, copy: string, claimIds: string[]): Promise<CopyCheckResult> {
    const post = await deps.postTarget(clientId, postId);
    if (!post) return { ok: false, code: "post_not_found", message: `${postId} is not a post of this client`, problems: [] };
    const target = targetOf(post);
    let input: DrafterInput | null;
    try {
      input = await deps.input(clientId, target.serviceId, target.keywordId ?? null);
    } catch (e) {
      return { ok: false, code: "brief_refused", message: (e as Error).message, problems: [] };
    }
    if (!input?.client) return { ok: false, code: "post_not_found", message: "the client has no Client Intelligence", problems: [] };
    const built = buildBrief(input, target, { socialAccounts: workspaceAccounts(input, await deps.socialAccounts(clientId)) });
    if (!built.ok) {
      return { ok: false, code: "brief_refused", message: built.refusals.map((r) => `${r.code}: ${r.message}`).join(" "),
        problems: built.refusals.map((r) => ({ code: r.code, message: r.message })) };
    }
    const state = input.client.state ?? null;
    const lint = lintDraft(built.brief, { copy, claim_ids: claimIds, asset_ids: target.assetIds },
      { gazetteer: (state && deps.gazetteer?.[state]) || [] });
    if (!lint.ok) {
      return { ok: false, code: "lint_failed", message: lint.problems.map((p) => `${p.code}: ${p.message}`).join(" "), problems: lint.problems };
    }
    return { ok: true, brief_hash: await briefHash(built.brief), warnings: lint.warnings };
  };
}
