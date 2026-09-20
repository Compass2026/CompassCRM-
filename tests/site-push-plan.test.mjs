import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePushPlan, detectStack, branchOfRecord, archiveAllowed, previewBranchName, FOUNDATION_SIDE_BRANCH } from "../supabase/functions/site-push/plan.ts";

const base = (over = {}) => ({
  requestedBranch: null,
  previewRequested: false,
  pullRequest: false,
  productionBranchHint: null,
  siteRow: null,
  repoDefaultBranch: "main",
  repoEmpty: false,
  headAuthorName: "Compass CRM",
  filePaths: ["package.json", "next.config.ts", "brands/registry.ts"],
  today: new Date("2026-09-21T00:00:00Z"),
  slug: "ridge",
  ...over,
});

test("a new Foundation build into an empty repo lands on main, deploys to production and is recorded as nextjs (never astro)", () => {
  const p = resolvePushPlan(base({ repoEmpty: true, repoDefaultBranch: null, headAuthorName: null, siteRow: { branch: null, stack: null, work_mode: "new_build", controlled_by_compass: true, vercel_project: null } }));
  assert.equal(p.refuse, null);
  assert.equal(p.branch, "main");
  assert.equal(p.deployTarget, "production");
  assert.equal(p.recordAsBranchOfRecord, true);
  assert.equal(p.stackForInsert, "nextjs");
});

test("a site with no row is recorded from the pushed files, and never defaults to astro", () => {
  assert.equal(detectStack(["astro.config.mjs"]), "astro");
  assert.equal(detectStack(["next.config.mjs"]), "nextjs");
  assert.equal(detectStack(["index.html"]), "other");
  const p = resolvePushPlan(base({ headAuthorName: null, repoEmpty: true, filePaths: ["index.html"] }));
  assert.equal(p.stackForInsert, "other");
});

test("a client-retains site is refused: the CRM never pushes to it", () => {
  const p = resolvePushPlan(base({ siteRow: { branch: null, stack: "other", work_mode: "client_retains", controlled_by_compass: false, vercel_project: null } }));
  assert.ok(p.refuse);
  assert.equal(p.refuse.status, 409);
  assert.match(p.refuse.error, /proposed document/);
});

test("non-main production branch: the preview is created from it and the PR targets it; the branch of record does not move", () => {
  const site = { branch: "production", stack: "nextjs", work_mode: "upgrade_existing", controlled_by_compass: true, vercel_project: "ridge-safety" };
  const p = resolvePushPlan(base({ siteRow: site, requestedBranch: "compass/2026-09-foundation-preview", pullRequest: true }));
  assert.equal(p.refuse, null);
  assert.equal(p.base, "production");
  assert.equal(p.createFrom, "production");
  assert.equal(p.prBase, "production");
  assert.equal(p.branch, "compass/2026-09-foundation-preview");
  assert.equal(p.deployTarget, "preview");
  assert.equal(p.recordAsBranchOfRecord, false);
  assert.equal(p.recordAsPreviewBranch, true);
});

test("an upgrade push straight at the branch of record without naming it is refused", () => {
  const site = { branch: "production", stack: "nextjs", work_mode: "upgrade_existing", controlled_by_compass: true, vercel_project: "x" };
  const p = resolvePushPlan(base({ siteRow: site }));
  assert.ok(p.refuse);
  assert.match(p.refuse.error, /preview branch/);
});

test("an authorised content-contract entry names the branch of record explicitly and deploys to production", () => {
  const site = { branch: "production", stack: "nextjs", work_mode: "upgrade_existing", controlled_by_compass: true, vercel_project: "x" };
  const p = resolvePushPlan(base({ siteRow: site, requestedBranch: "production" }));
  assert.equal(p.refuse, null);
  assert.equal(p.branch, "production");
  assert.equal(p.deployTarget, "production");
  assert.equal(p.recordAsBranchOfRecord, true);
});

test("preview: true without a branch name gets a dated compass/preview-* branch from the branch of record", () => {
  const site = { branch: "release", stack: "nextjs", work_mode: "upgrade_existing", controlled_by_compass: true, vercel_project: "x" };
  const p = resolvePushPlan(base({ siteRow: site, previewRequested: true }));
  assert.equal(p.branch, "compass/preview-20260921-ridge");
  assert.equal(p.createFrom, "release");
  assert.equal(p.prBase, "release");
  assert.equal(previewBranchName("ridge", new Date("2026-09-21T00:00:00Z")), "compass/preview-20260921-ridge");
});

test("no site row and a repo whose default branch is not main: the default branch is the baseline, not main", () => {
  assert.equal(branchOfRecord(null, "trunk", null), "trunk");
  assert.equal(branchOfRecord({ branch: "production", stack: null, work_mode: null, controlled_by_compass: null, vercel_project: null }, "main", null), "production");
  assert.equal(branchOfRecord(null, null, "release"), "release");
  const p = resolvePushPlan(base({ repoDefaultBranch: "trunk", previewRequested: true }));
  assert.equal(p.base, "trunk");
  assert.equal(p.prBase, "trunk");
});

test("a full build over someone else's branch of record goes to the foundation side branch with a note", () => {
  const p = resolvePushPlan(base({ headAuthorName: "Tom", siteRow: { branch: "main", stack: "nextjs", work_mode: null, controlled_by_compass: true, vercel_project: null } }));
  assert.equal(p.branch, FOUNDATION_SIDE_BRANCH);
  assert.equal(p.deployTarget, "preview");
  assert.equal(p.recordAsBranchOfRecord, false);
  assert.match(p.note, /not ours/);
});

test("the archive mode only serves the client's own repo or the pinned foundation SHA", () => {
  const f = { repo: "Compass2026/showmeelectricalwebsite", sha: "94014af35316c94616dadb3f8d606a4b68577fb0" };
  assert.equal(archiveAllowed({ repo: "Compass2026/showmeelectricalwebsite", ref: f.sha }, null, f), true);
  assert.equal(archiveAllowed({ repo: "Compass2026/showmeelectricalwebsite", ref: "main" }, null, f), false);
  assert.equal(archiveAllowed({ repo: "Compass2026/ridge-safety", ref: "production" }, "Compass2026/ridge-safety", f), true);
  assert.equal(archiveAllowed({ repo: "someone/else", ref: "main" }, "Compass2026/ridge-safety", f), false);
});
