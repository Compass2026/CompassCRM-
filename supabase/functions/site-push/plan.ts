// site-push — the branch / baseline / pull-request decision, kept free of
// Deno and network so it can be unit-tested with `node --test` (tests/
// site-push-plan.test.mjs) and read on its own.
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

export type WorkMode = "new_build" | "upgrade_existing" | "client_retains";
export type SiteStack = "astro" | "nextjs" | "other";

export interface SiteRowForPlan {
  branch: string | null;
  stack: SiteStack | null;
  work_mode: WorkMode | null;
  controlled_by_compass: boolean | null;
  vercel_project: string | null;
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
  /** Files in the push, used to detect the stack of a site with no row. */
  filePaths: string[];
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
  /** Explanation for the response / evidence. */
  note: string | null;
}

export const FOUNDATION_SIDE_BRANCH = "compass/foundation-build";
export const CRM_AUTHOR = "Compass CRM";

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

export function resolvePushPlan(input: PlanInput): PushPlan {
  const site = input.siteRow;
  const base = branchOfRecord(site, input.repoDefaultBranch, input.productionBranchHint);
  const stackForInsert: SiteStack = site?.stack ?? detectStack(input.filePaths);
  const mode: WorkMode | null = site?.work_mode ?? null;

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
    note: null,
    ...p,
  });

  // A site the client runs is never pushed to. The stage files proposed
  // documents instead (docs/website-updates.md).
  if (mode === "client_retains" || (site && site.controlled_by_compass === false)) {
    return plan({
      refuse: {
        status: 409,
        error:
          "This site is client-managed (work mode client_retains): the CRM does not push to it. File the change as a proposed document in Drive 04 Website.",
      },
      deployTarget: "preview",
    });
  }

  // Explicit side branch, or an auto-named preview.
  const requested = input.requestedBranch?.trim() || null;
  const wantsPreview = input.previewRequested || input.pullRequest || (requested !== null && requested !== base);
  if (wantsPreview) {
    const branch = requested && requested !== base ? requested : previewBranchName(input.slug ?? "site", input.today);
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
  if (mode === "upgrade_existing") {
    // An existing site Tom built: nothing lands on its production branch
    // without a preview and a pull request, unless the caller named the
    // branch of record explicitly (the on-contract data entries — city
    // pages, blog posts — that Tom authorised to publish without a look).
    if (requested !== base) {
      return plan({
        refuse: {
          status: 409,
          error: `Work mode upgrade_existing: push to a preview branch with pull_request (base ${base}), or name branch "${base}" explicitly for an authorised content-contract entry.`,
        },
        deployTarget: "preview",
      });
    }
    return plan({ recordAsBranchOfRecord: true, note: `Authorised content entry on the branch of record ${base}.` });
  }

  // A repo whose branch of record already carries someone else's work is
  // never overwritten by a full build: it goes to a side branch and the
  // caller is told. (Pensacola's hand-built site was the original case.)
  if (!input.repoEmpty && input.headAuthorName && input.headAuthorName !== CRM_AUTHOR && requested !== base && mode !== "new_build") {
    return plan({
      branch: FOUNDATION_SIDE_BRANCH,
      createFrom: null, // an orphan branch carrying only our tree
      prBase: base,
      deployTarget: "preview",
      recordAsPreviewBranch: true,
      note: `${base} already carries a site that is not ours; the build is on ${FOUNDATION_SIDE_BRANCH} for Tom to blend.`,
    });
  }

  // A new build (or an explicitly named branch of record) lands on the
  // branch of record and deploys to production.
  return plan({ recordAsBranchOfRecord: true, note: input.repoEmpty ? `Root commit on ${base}.` : null });
}

/** Which repositories the archive mode may fetch: the client's own, or the pinned foundation. */
export function archiveAllowed(requested: { repo: string; ref: string }, clientRepo: string | null, foundation: { repo: string; sha: string } | null): boolean {
  const same = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  if (same(clientRepo, requested.repo)) return true;
  if (foundation && same(foundation.repo, requested.repo) && foundation.sha.toLowerCase() === requested.ref.toLowerCase()) return true;
  return false;
}
