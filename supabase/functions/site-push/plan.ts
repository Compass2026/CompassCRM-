// site-push — the branch / baseline / pull-request decision, kept free of
// Deno and network so it can be unit-tested with `node --test` (tests/
// site-push-plan.test.mjs) and read on its own. The request handler
// (handler.ts) is tested at its own boundary with mocked GitHub / Supabase.
//
// Vocabulary
//   branch of record   the branch the site's production deployment serves.
//                      `sites.branch` when the row has it, else the repo's
//                      default branch, else "main". It is never assumed to
//                      be main and a preview push never moves it.
//   preview branch     a side branch created FROM the branch of record for
//                      work Tom looks at before it lands: pull request base
//                      = the branch of record, Vercel target = preview.
//   work mode          `sites.work_mode`: new_build (a Foundation build into
//                      an empty or Compass-owned repo), upgrade_existing (a
//                      site Tom already built; changes go through previews),
//                      client_retains (the client runs the site; the CRM
//                      never pushes — content lands as proposed documents).
//   content entry      the one automatic production publication Tom
//                      authorised (Sept 14 2026): a DATA ENTRY on the site's
//                      recorded adapter (a city or blog entry on the Lucas
//                      contract, a Markdown post on the BHG shape). Granted
//                      only when the request names the branch of record AND
//                      every file is a push-permitted write path of the
//                      recorded adapter AND nothing is deleted. Any other
//                      change to a branch of record that carries a site is
//                      a preview + pull request.

import { validateContentEntry, type ContentAdapterKey, type ContentPaths } from "../../../src/lib/content-adapters.ts";

export type WorkMode = "new_build" | "upgrade_existing" | "client_retains";
export type SiteStack = "astro" | "nextjs" | "other";

export interface SiteRowForPlan {
  branch: string | null;
  stack: SiteStack | null;
  work_mode: WorkMode | null;
  controlled_by_compass: boolean | null;
  vercel_project: string | null;
  content_adapter?: ContentAdapterKey | string | null;
  content_paths?: ContentPaths | null;
}

export interface PlanInput {
  /** `branch` from the request body, if any. */
  requestedBranch: string | null;
  /** `preview: true` in the body asks for an auto-named preview branch. */
  previewRequested: boolean;
  /** `pull_request` in the body (a PR will be opened against the base). */
  pullRequest: boolean;
  /** `production_branch` in the body — only honoured when the site row has none. */
  productionBranchHint: string | null;
  siteRow: SiteRowForPlan | null;
  /** GitHub's `default_branch` for the repo (null when the repo was just created). */
  repoDefaultBranch: string | null;
  /** True when the repository has no commits at all. */
  repoEmpty: boolean;
  /** Author name of the branch-of-record head commit, when it exists. */
  headAuthorName: string | null | undefined;
  /** Files in the push. */
  filePaths: string[];
  /** Paths the push deletes. */
  deletePaths?: string[];
  /** Today, for the auto-named preview branch. */
  today?: Date;
  /** A slug for the auto-named preview branch. */
  slug?: string;
}

export interface PushPlan {
  /** Refuse the push outright (HTTP status + message). */
  refuse: { status: number; error: string } | null;
  /** The branch the commit goes to. */
  branch: string;
  /** The branch of record (production). */
  base: string;
  /** When the branch does not exist yet, create it from this branch's head. */
  createFrom: string | null;
  /** Pull request base — always the branch of record. */
  prBase: string;
  /** Vercel target: production only for the branch of record. */
  deployTarget: "production" | "preview";
  /** Whether a successful push may update `sites.branch`. */
  recordAsBranchOfRecord: boolean;
  /** Whether to record the branch as `sites.preview_branch`. */
  recordAsPreviewBranch: boolean;
  /** Stack to write on a site row inserted by this push. Never defaults to astro. */
  stackForInsert: SiteStack;
  /** Why a production push was allowed: a fresh build, or an authorised content entry. */
  grant: "new_build" | "content_entry" | "compass_owned" | null;
  /** Explanation for the response / evidence. */
  note: string | null;
}

export const FOUNDATION_SIDE_BRANCH = "compass/foundation-build";
export const CRM_AUTHOR = "Compass CRM";
/**
 * The one commit identity every site-push commit carries — author AND
 * committer, on every path (revert, empty-repo bootstrap, normal tree).
 * The email must be a Vercel team member's: Vercel's Git integration marks a
 * deployment BLOCKED when the commit author is not on the team, which is what
 * kept the CRM's own commits from deploying.
 */
export const CRM_COMMIT_IDENTITY = { name: CRM_AUTHOR, email: "thomas@compassmarketing.ai" } as const;

/** The stack a set of pushed files implies. Unknown stays `other`. */
export function detectStack(paths: string[]): SiteStack {
  if (paths.some((p) => /^next\.config\.(js|mjs|ts|cjs)$/.test(p))) return "nextjs";
  if (paths.some((p) => /^astro\.config\.(js|mjs|ts|cjs)$/.test(p))) return "astro";
  return "other";
}

export function branchOfRecord(siteRow: SiteRowForPlan | null, repoDefaultBranch: string | null, hint: string | null): string {
  return siteRow?.branch?.trim() || hint?.trim() || repoDefaultBranch?.trim() || "main";
}

export function previewBranchName(slug: string, today = new Date()): string {
  const d = today.toISOString().slice(0, 10).replace(/-/g, "");
  return `compass/preview-${d}-${slug}`.replace(/[^a-zA-Z0-9/_.-]+/g, "-");
}

const KNOWN_ADAPTERS: ContentAdapterKey[] = ["foundation_brand_content", "lucas_json", "markdown_blog", "unsupported"];

function adapterOf(site: SiteRowForPlan | null): ContentAdapterKey | null {
  const key = site?.content_adapter ?? site?.content_paths?.adapter ?? null;
  return key && (KNOWN_ADAPTERS as string[]).includes(key) ? (key as ContentAdapterKey) : null;
}

export function resolvePushPlan(input: PlanInput): PushPlan {
  const site = input.siteRow;
  const base = branchOfRecord(site, input.repoDefaultBranch, input.productionBranchHint);
  const stackForInsert: SiteStack = site?.stack ?? detectStack(input.filePaths);
  const mode: WorkMode | null = site?.work_mode ?? null;
  const deletes = input.deletePaths ?? [];

  const plan = (p: Partial<PushPlan>): PushPlan => ({
    refuse: null,
    branch: base,
    base,
    createFrom: null,
    prBase: base,
    deployTarget: "production",
    recordAsBranchOfRecord: false,
    recordAsPreviewBranch: false,
    stackForInsert,
    grant: null,
    note: null,
    ...p,
  });
  const refuse = (error: string, status = 409): PushPlan => plan({ refuse: { status, error }, deployTarget: "preview" });

  // A site the client runs is never pushed to. The stage files proposed
  // documents instead (docs/website-updates.md).
  if (mode === "client_retains" || (site && site.controlled_by_compass === false)) {
    return refuse(
      "This site is client-managed (work mode client_retains): the CRM does not push to it. File the change as a proposed document in Drive 04 Website."
    );
  }

  // Explicit side branch, or an auto-named preview.
  const requested = input.requestedBranch?.trim() || null;
  const wantsPreview = input.previewRequested || input.pullRequest || (requested !== null && requested !== base);
  if (wantsPreview) {
    let branch = requested && requested !== base ? requested : previewBranchName(input.slug ?? "site", input.today);
    // The preview branch must never BE the branch of record. The auto-named
    // one can collide with it — a site whose branch of record is itself an
    // old `compass/preview-<date>-<slug>` branch generates the same name
    // again — and the commit would then land on the branch of record with no
    // pull request, which is the one thing a preview push exists to prevent.
    // Seen live on Sept 20 2026 during the upgrade_existing exercise.
    if (branch === base) branch = `${branch}-preview`;
    return plan({
      branch,
      createFrom: input.repoEmpty ? null : base,
      prBase: base,
      deployTarget: "preview",
      recordAsPreviewBranch: true,
      note: `Preview branch ${branch} from ${base}; the branch of record (${base}) is unchanged.`,
    });
  }

  // From here on the push targets the branch of record itself.
  const namedBase = requested === base;
  const entry = namedBase ? validateContentEntry(adapterOf(site), site?.content_paths ?? null, input.filePaths, deletes) : null;
  const foreignHead = !input.repoEmpty && !!input.headAuthorName && input.headAuthorName !== CRM_AUTHOR;

  if (mode === "upgrade_existing") {
    // An existing site Tom built: nothing lands on its production branch
    // without a preview and a pull request, except an authorised content
    // entry that names the branch of record and stays on the adapter's
    // data paths.
    if (!namedBase) {
      return refuse(`Work mode upgrade_existing: push to a preview branch with pull_request (base ${base}), or name branch "${base}" explicitly for an authorised content-contract entry.`);
    }
    if (!entry!.ok) {
      return refuse(`Work mode upgrade_existing, branch "${base}" named but the request is not an authorised content entry — ${entry!.reason}.`);
    }
    return plan({ recordAsBranchOfRecord: true, grant: "content_entry", note: `Authorised content entry (${entry!.kinds.join(", ")}) on the branch of record ${base}.` });
  }

  // A branch of record that already carries someone else's work is never
  // overwritten — whatever the work mode says. A "new build" label does not
  // authorise replacing an existing production site: the build goes to a
  // side branch and the caller is told. (Pensacola's hand-built site was
  // the original case.) The only exception is, again, an authorised
  // content entry on the recorded adapter.
  if (foreignHead) {
    if (namedBase && entry!.ok) {
      return plan({ recordAsBranchOfRecord: true, grant: "content_entry", note: `Authorised content entry (${entry!.kinds.join(", ")}) on the branch of record ${base}.` });
    }
    return plan({
      branch: FOUNDATION_SIDE_BRANCH,
      createFrom: null, // an orphan branch carrying only our tree
      prBase: base,
      deployTarget: "preview",
      recordAsPreviewBranch: true,
      note: `${base} already carries a site that is not ours${mode === "new_build" ? " (work mode new_build does not override that)" : ""}; the build is on ${FOUNDATION_SIDE_BRANCH} for Tom to blend.`,
    });
  }

  // Nothing there, or only our own commits: a new build (or a push to a
  // Compass-authored branch of record) lands on it and deploys to production.
  return plan({
    recordAsBranchOfRecord: true,
    grant: input.repoEmpty ? "new_build" : "compass_owned",
    note: input.repoEmpty ? `Root commit on ${base}.` : null,
  });
}

/** Which repositories the archive mode may fetch: the client's own, or the pinned foundation. */
export function archiveAllowed(requested: { repo: string; ref: string }, clientRepo: string | null, foundation: { repo: string; sha: string } | null): boolean {
  const same = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  if (same(clientRepo, requested.repo)) return true;
  if (foundation && same(foundation.repo, requested.repo) && foundation.sha.toLowerCase() === requested.ref.toLowerCase()) return true;
  return false;
}
