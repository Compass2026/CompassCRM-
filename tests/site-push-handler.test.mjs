// Request-boundary tests for the site-push Edge Function: the real handler
// (supabase/functions/site-push/handler.ts) with a fake Supabase client and
// a fake GitHub API. No network; nothing is deployed or delivered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSitePushHandler, SITE_PUSH_VERSION } from "../supabase/functions/site-push/handler.ts";
import { CRM_COMMIT_IDENTITY } from "../supabase/functions/site-push/plan.ts";
import { fakeSupabase, fakeGitHub } from "./helpers/fakes.mjs";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const secrets = { SYNC_CRON_SECRET: "cron", GITHUB_TOKEN: "ghp_fake", GITHUB_ORG: "Compass2026" };
const clientRow = { id: CLIENT, name: "Ridge Safety Group", website_url: "https://ridge.example" };

function setup({ site, repos, release = null, vercel = null } = {}) {
  const supabase = fakeSupabase({
    // A Vercel token only where the test opts into the Vercel fake, so the
    // other tests keep exercising the "no token, no deployment" path.
    secrets: vercel ? { ...secrets, VERCEL_TOKEN: "vt_fake" } : secrets,
    tables: {
      clients: [clientRow],
      sites: site ? [{ id: "site-1", client_id: CLIENT, ...site }] : [],
      foundation_releases: release ? [release] : [],
    },
  });
  const gh = fakeGitHub({ repos, vercel });
  // Milliseconds, not minutes: the real polling loops run, just quickly.
  const handler = createSitePushHandler({ supabase, fetch: gh.fetch, timing: { findMs: 120, settleMs: 120, pollMs: 10 } });
  const post = async (body, headers = { "x-cron-secret": "cron" }) => {
    const res = await handler(new Request("https://fn.local/site-push", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    const ct = res.headers.get("content-type") ?? "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : await res.text(), headers: res.headers };
  };
  return { supabase, gh, post, site: () => supabase.store.sites[0] };
}

const LUCAS_SITE = {
  url: "https://ridge.example", stack: "nextjs", controlled_by_compass: true, repo_url: "https://github.com/Compass2026/ridge-safety", branch: "main", preview_branch: null,
  vercel_project: "ridge-safety", work_mode: "upgrade_existing", content_adapter: "lucas_json",
  content_paths: { adapter: "lucas_json", locations: "data/locations.json", blog: "data/blog-posts.json", blog_format: "json" },
};
const TOM_REPO = { "Compass2026/ridge-safety": { id: 42, default_branch: "main", branches: { main: { author: "Tom" } } } };

test("version mode reports the deployed contract", async () => {
  const { post } = setup();
  const r = await post({ client_id: CLIENT, version: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, SITE_PUSH_VERSION);
  assert.ok(r.body.features.includes("content_entry_boundary"));
  assert.ok(r.body.features.includes("native_git_deploy"), "the worker's preflight must be able to tell a function that relies on Vercel's own Git deployment from one that made its own");
  assert.ok(SITE_PUSH_VERSION >= 11, "the native-Git-deploy contract landed in v11");
});

test("no cron secret and no team session → 401 before anything is read", async () => {
  const { post, gh } = setup({ site: LUCAS_SITE, repos: TOM_REPO });
  const r = await post({ client_id: CLIENT, branch: "main", files: [{ path: "data/blog-posts.json", content: "[]" }] }, { Authorization: "Bearer nope" });
  assert.equal(r.status, 401);
  assert.equal(gh.calls.length, 0);
});

test("a signed-in user who is not a team member → 403 before anything is read (team-only boundary from migration 0036_team_only_access)", async () => {
  const { post, gh } = setup({ site: LUCAS_SITE, repos: TOM_REPO });
  const r = await post({ client_id: CLIENT, branch: "main", files: [{ path: "data/blog-posts.json", content: "[]" }] }, { Authorization: "Bearer client-jwt" });
  assert.equal(r.status, 403);
  assert.equal(gh.calls.length, 0);
});

test("a 250-file new build is one tree request: text inline, a blob only per binary (GitHub secondary rate limit)", async () => {
  const { post, gh } = setup({ site: { ...LUCAS_SITE, work_mode: "new_build", branch: null, content_adapter: null, content_paths: null }, repos: { "Compass2026/lucas_construction": { id: 7, default_branch: "main", empty: true, branches: {} } } });
  const files = Array.from({ length: 250 }, (_, i) => ({ path: `brands/x/content/file-${i}.ts`, content: `export const f${i} = ${i};` }));
  files.push({ path: "public/a.png", content: "AAAA", encoding: "base64" }, { path: "public/b.png", content: "BBBB", encoding: "base64" }, { path: "public/c.webp", content: "CCCC", encoding: "base64" });
  const r = await post({ client_id: CLIENT, preview: true, message: "build", files });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const blobs = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/blobs"));
  const trees = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/trees"));
  assert.equal(blobs.length, 3);
  assert.equal(trees.length, 1);
  const inline = trees[0].body.tree.filter((e) => typeof e.content === "string");
  const bySha = trees[0].body.tree.filter((e) => typeof e.sha === "string");
  assert.equal(inline.length, 249, "the bootstrap file goes through the Contents API; the other 249 text files ride inline");
  assert.equal(bySha.length, 3);
});

test("naming the production branch with general code changes is refused: nothing is written to GitHub or the site row", async () => {
  const { post, gh, site } = setup({ site: LUCAS_SITE, repos: TOM_REPO });
  const r = await post({ client_id: CLIENT, branch: "main", message: "x", files: [{ path: "src/app/page.tsx", content: "a" }, { path: "src/components/Header.tsx", content: "b" }] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not an authorised content entry/);
  assert.equal(r.body.branch_of_record, "main");
  assert.equal(gh.writes().length, 0, JSON.stringify(gh.writes()));
  assert.equal(site().last_commit_url, undefined);
  assert.equal(site().branch, "main");
});

test("a data entry mixed with code, or with a deletion, is refused too", async () => {
  const { post, gh } = setup({ site: LUCAS_SITE, repos: TOM_REPO });
  const mixed = await post({ client_id: CLIENT, branch: "main", files: [{ path: "data/blog-posts.json", content: "[]" }, { path: "src/app/layout.tsx", content: "x" }] });
  assert.equal(mixed.status, 409);
  const del = await post({ client_id: CLIENT, branch: "main", files: [{ path: "data/blog-posts.json", content: "[]" }], delete: ["src/app/layout.tsx"] });
  assert.equal(del.status, 409);
  assert.match(del.body.error, /deletions/);
  assert.equal(gh.writes().length, 0);
});

test("an authorised blog/data entry on the recorded adapter publishes to the branch of record", async () => {
  const { post, gh, site } = setup({ site: LUCAS_SITE, repos: TOM_REPO });
  const before = gh.model["Compass2026/ridge-safety"].refs.main;
  const r = await post({ client_id: CLIENT, branch: "main", message: "Blog: x (Compass CRM)", files: [{ path: "data/blog-posts.json", content: "[]" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.branch, "main");
  assert.equal(r.body.grant, "content_entry");
  assert.equal(r.body.target, "production");
  assert.equal(r.body.vercel.status, "skipped"); // no VERCEL_TOKEN in the fake vault
  const after = gh.model["Compass2026/ridge-safety"].refs.main;
  assert.notEqual(after, before);
  assert.equal(gh.model["Compass2026/ridge-safety"].commits[after].parents[0], before, "the entry commit builds on the existing head");
  assert.equal(site().branch, "main");
  assert.match(site().last_commit_url, /\/commit\/commit-/);
});

test("upgrade_existing preview on a non-main production branch: created from it, PR against it, branch of record untouched", async () => {
  const site = { ...LUCAS_SITE, branch: "production" };
  const repos = { "Compass2026/ridge-safety": { id: 42, default_branch: "main", branches: { main: { author: "Tom" }, production: { author: "Tom" } } } };
  const { post, gh, site: row } = setup({ site, repos });
  const prodHead = gh.model["Compass2026/ridge-safety"].refs.production;
  const mainHead = gh.model["Compass2026/ridge-safety"].refs.main;
  const r = await post({ client_id: CLIENT, preview: true, message: "upgrade", files: [{ path: "src/app/page.tsx", content: "new" }], pull_request: { title: "Ridge: upgrade", body: "preview" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.branch, /^compass\/preview-\d{8}-ridgesafetygroup$/);
  assert.equal(r.body.branch_of_record, "production");
  assert.equal(r.body.pull_request_base, "production");
  assert.equal(r.body.target, "preview");
  assert.match(r.body.pull_request_url, /\/pull\/1$/);
  const created = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/git/refs"));
  assert.equal(created.body.sha, prodHead, "the preview branch starts at the production head");
  const pr = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"));
  assert.equal(pr.body.base, "production");
  assert.equal(gh.model["Compass2026/ridge-safety"].refs.production, prodHead, "production did not move");
  assert.equal(gh.model["Compass2026/ridge-safety"].refs.main, mainHead, "main did not move");
  assert.equal(row().branch, "production");
  assert.equal(row().preview_branch, r.body.branch);
});

test("a new_build push into a repository whose main was authored by someone else is parked on the foundation side branch", async () => {
  const site = { ...LUCAS_SITE, work_mode: "new_build", content_adapter: null, content_paths: null };
  const { post, gh, site: row } = setup({ site, repos: TOM_REPO });
  const mainHead = gh.model["Compass2026/ridge-safety"].refs.main;
  const r = await post({ client_id: CLIENT, message: "Foundation v1 build (Compass CRM)", brand: "ridge", files: [{ path: "package.json", content: "{}" }, { path: "next.config.ts", content: "export default {}" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.branch, "compass/foundation-build");
  assert.equal(r.body.target, "preview");
  assert.match(r.body.note, /not ours/);
  assert.equal(gh.model["Compass2026/ridge-safety"].refs.main, mainHead, "main was not overwritten");
  const side = gh.model["Compass2026/ridge-safety"].refs["compass/foundation-build"];
  assert.ok(side);
  assert.deepEqual(gh.model["Compass2026/ridge-safety"].commits[side].parents, [], "an orphan branch carrying only our tree");
  assert.equal(row().branch, "main");
  assert.equal(row().preview_branch, "compass/foundation-build");
});

test("a new_build into our own or an empty repository lands on the branch of record", async () => {
  const site = { ...LUCAS_SITE, work_mode: "new_build", content_adapter: null, content_paths: null, repo_url: "https://github.com/Compass2026/fresh-site" };
  const repos = { "Compass2026/fresh-site": { id: 7, default_branch: "main", empty: true } };
  const { post, gh, site: row } = setup({ site, repos });
  const r = await post({ client_id: CLIENT, message: "Foundation v1 build (Compass CRM)", files: [{ path: "package.json", content: "{}" }, { path: "next.config.ts", content: "x" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.branch, "main");
  assert.equal(r.body.target, "production");
  assert.equal(r.body.grant, "new_build");
  assert.ok(gh.model["Compass2026/fresh-site"].refs.main);
  assert.equal(row().branch, "main");
});

test("a client-managed site is never pushed to", async () => {
  const site = { ...LUCAS_SITE, work_mode: "client_retains", controlled_by_compass: false };
  const { post, gh } = setup({ site, repos: TOM_REPO });
  const r = await post({ client_id: CLIENT, branch: "main", files: [{ path: "data/blog-posts.json", content: "[]" }] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /client-managed/);
  assert.equal(gh.writes().length, 0);
});

test("no site row and a repository whose default branch is trunk: the baseline is trunk and the inserted row is never astro", async () => {
  const repos = { "Compass2026/ridgesafetygroup": { id: 9, default_branch: "trunk", branches: { trunk: { author: "Compass CRM" } } } };
  const { post, supabase } = setup({ repos });
  const r = await post({ client_id: CLIENT, preview: true, message: "x", files: [{ path: "next.config.ts", content: "x" }, { path: "data/x.json", content: "{}" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.branch_of_record, "trunk");
  const inserted = supabase.writes.find((w) => w.table === "sites" && w.op === "insert");
  assert.equal(inserted.row.stack, "nextjs");
  assert.equal(inserted.row.branch, "trunk");
  assert.match(inserted.row.preview_branch, /^compass\/preview-/);
  assert.equal(inserted.row.work_mode, "new_build");
});

test("archive mode serves only the client's repository or the current foundation release", async () => {
  const release = { id: "r1", version: "v1", source_repo: "Compass2026/showmeelectricalwebsite", source_sha: "94014af35316c94616dadb3f8d606a4b68577fb0", is_current: true };
  const repos = { ...TOM_REPO, "Compass2026/showmeelectricalwebsite": { id: 1, default_branch: "main", branches: { main: { author: "x" } } }, "someone/else": { id: 2, default_branch: "main", branches: { main: {} } } };
  const { post } = setup({ site: LUCAS_SITE, repos, release });
  const denied = await post({ client_id: CLIENT, archive: { repo: "someone/else", ref: "main" } });
  assert.equal(denied.status, 403);
  const wrongRef = await post({ client_id: CLIENT, archive: { repo: "Compass2026/showmeelectricalwebsite", ref: "main" } });
  assert.equal(wrongRef.status, 403);
  const ok = await post({ client_id: CLIENT, archive: { repo: "Compass2026/showmeelectricalwebsite", ref: release.source_sha } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /gzip/);
  assert.match(ok.body, /TARBALL Compass2026\/showmeelectricalwebsite@94014af/);
  const own = await post({ client_id: CLIENT, archive: { repo: "Compass2026/ridge-safety", ref: "main" } });
  assert.equal(own.status, 200);
});

// ── Commit identity ───────────────────────────────────────────────────────
// Vercel's Git integration marks a deployment BLOCKED when the commit author
// is not a team member, which is what the deployment-author mismatch was. So
// every commit this function makes — on all three paths — must carry the one
// CRM_COMMIT_IDENTITY as BOTH author and committer.
const TEAM_EMAIL = "thomas@compassmarketing.ai";

function assertIdentity(body, where) {
  for (const role of ["author", "committer"]) {
    assert.ok(body?.[role], `${where}: no ${role} on the commit`);
    assert.equal(body[role].email, TEAM_EMAIL, `${where}: ${role}.email must be the team member's`);
    assert.equal(body[role].name, CRM_COMMIT_IDENTITY.name, `${where}: ${role}.name`);
  }
}

test("normal tree commits are authored and committed by the Vercel team member", async () => {
  const { post, gh } = setup({ site: LUCAS_SITE, repos: TOM_REPO });
  const r = await post({ client_id: CLIENT, branch: "main", message: "Blog: x (Compass CRM)", files: [{ path: "data/blog-posts.json", content: "[]" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const commits = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits"));
  assert.equal(commits.length, 1);
  assertIdentity(commits[0].body, "tree commit");
});

test("the empty-repository bootstrap commit carries the same identity", async () => {
  const { post, gh } = setup({
    site: { ...LUCAS_SITE, work_mode: "new_build", branch: null, content_adapter: null, content_paths: null },
    repos: { "Compass2026/ridge-safety": { id: 42, default_branch: "main", empty: true, branches: {} } },
  });
  const r = await post({ client_id: CLIENT, preview: true, message: "Foundation v1 build (Compass CRM)", files: [{ path: "package.json", content: "{}" }, { path: "next.config.ts", content: "export default {}" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bootstrap = gh.calls.filter((c) => c.method === "PUT" && c.path.includes("/contents/"));
  assert.equal(bootstrap.length, 1, "the first file seeds the repo through the Contents API");
  assertIdentity(bootstrap[0].body, "bootstrap commit");
  // The tree commit that carries the rest of the files answers to it too.
  const commits = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits"));
  assert.equal(commits.length, 1);
  assertIdentity(commits[0].body, "tree commit after bootstrap");
});

test("a revert commit carries the same identity", async () => {
  const { post, gh } = setup({ site: LUCAS_SITE, repos: TOM_REPO });
  const pushed = await post({ client_id: CLIENT, branch: "main", message: "Blog: x (Compass CRM)", files: [{ path: "data/blog-posts.json", content: "[]" }] });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
  const r = await post({ client_id: CLIENT, revert: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const commits = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits"));
  assert.equal(commits.length, 2, "the push, then the revert");
  assertIdentity(commits[1].body, "revert commit");
});

test("no commit path ships the old non-team address", async () => {
  // A belt-and-braces sweep of the source: the identity lives in exactly one
  // place, so a new commit path cannot quietly reintroduce the old one.
  const src = await readFile(new URL("../supabase/functions/site-push/handler.ts", import.meta.url), "utf8");
  assert.equal(/crm@compassmarketing\.ai/.test(src), false, "the old non-team commit address is gone");
  assert.equal((src.match(/committer:/g) ?? []).length, 3, "three commit paths, each with a committer");
  assert.equal((src.match(/author: CRM_COMMIT_IDENTITY/g) ?? []).length, 3, "three commit paths, each with an author");
});

// ── One deployment path per push ──────────────────────────────────────────
// These pin what THIS function does: it issues exactly one deployment
// request per push, previews stay previews and production pushes deploy
// once. They cannot see Vercel's Git integration, which is a SECOND,
// out-of-band path triggered by the GitHub push itself — see
// docs/vercel-deployment-paths.md. Keep both halves honest: if the Git
// integration is ever allowed to deploy CRM commits, these tests still pass
// while the system deploys twice.
const deployPosts = (gh) => gh.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v13/deployments"));


// ── Native Git deployment (v11) ──────────────────────────────────────────
// site-push no longer creates a deployment for a push. Vercel's Git
// integration does — for Tom's commits, Codex's, and the CRM's alike — and
// site-push finds that one by commit SHA and verifies it. The fake models
// the integration: a push to a linked project creates exactly one
// deployment, production when the ref is the project's production branch,
// and (as observed live) production regardless when the project has none.
const restPosts = (gh) => gh.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v13/deployments"));
const established = (extra = {}) => ({
  projects: { "ridge-safety": { id: "prj_ridge-safety", repo: "Compass2026/ridge-safety", productionBranch: "main", deployments: 1 } },
  deployments: { dpl_seed: { id: "dpl_seed", url: "seed.vercel.app", target: "production", state: "READY", readyState: "READY", source: "git", sha: "seed" } },
  ...extra,
});

test("established project, push to the branch of record: Vercel's own deployment is found, production, and no REST deployment is made", async () => {
  const vercel = established();
  const { post, gh } = setup({ site: LUCAS_SITE, repos: TOM_REPO, vercel });
  const r = await post({ client_id: CLIENT, branch: "main", message: "Blog: x (Compass CRM)", files: [{ path: "data/blog-posts.json", content: "[]" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vercel.source, "git", "the deployment reported is Vercel's own");
  assert.equal(r.body.vercel.target, "production");
  assert.equal(r.body.vercel.ready_state, "READY");
  assert.ok(r.body.vercel.deployment_id.startsWith("dpl_git_"));
  assert.equal(restPosts(gh).length, 0, "site-push must not create a deployment for a push");
});

test("established project, preview branch: Vercel's deployment is a preview and stays one", async () => {
  const vercel = established();
  const { post, gh, site } = setup({
    site: { ...LUCAS_SITE, vercel_project: "ridge-safety", work_mode: "new_build", content_adapter: null, content_paths: null },
    repos: { "Compass2026/ridge-safety": { id: 42, default_branch: "main", branches: { main: { author: "Compass CRM" } } } },
    vercel,
  });
  const r = await post({ client_id: CLIENT, preview: true, message: "build", files: [{ path: "app/page.tsx", content: "x" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vercel.source, "git");
  assert.notEqual(r.body.vercel.target, "production");
  assert.equal(restPosts(gh).length, 0);
  assert.equal(site().branch, "main", "a preview never moves the branch of record");
});

test("brand-new project + preview branch: refused before the project is linked, because Vercel would promote it to production", async () => {
  // The hazard proven live: on a project with no successful deployment, a
  // side-branch push is deployed as PRODUCTION. site-push cannot refuse
  // after the fact — the integration deploys from the push — so it refuses
  // to link the project at all.
  const vercel = { projects: {} };
  const { post, gh } = setup({
    site: { ...LUCAS_SITE, vercel_project: null, work_mode: "new_build", content_adapter: null, content_paths: null },
    repos: { "Compass2026/ridge-safety": { id: 42, default_branch: "main", branches: { main: { author: "Compass CRM" } } } },
    vercel,
  });
  const r = await post({ client_id: CLIENT, preview: true, message: "build", files: [{ path: "app/page.tsx", content: "x" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vercel.status, "blocked");
  assert.match(r.body.vercel.detail, /no successful \(READY\) deployment yet/);
  assert.match(r.body.vercel.detail, /pushing the branch of record/);
  assert.equal(restPosts(gh).length, 0, "nothing is deployed");
});

test("two deployments for one commit are reported as a duplicate, never picked between", async () => {
  const vercel = established({ extraGitDeploy: true });
  const { post } = setup({ site: LUCAS_SITE, repos: TOM_REPO, vercel });
  const r = await post({ client_id: CLIENT, branch: "main", message: "Blog: x (Compass CRM)", files: [{ path: "data/blog-posts.json", content: "[]" }] });
  assert.equal(r.body.vercel.status, "duplicate");
  assert.equal(r.body.vercel.count, 2);
  assert.equal(r.body.vercel.deployments.length, 2);
  assert.match(r.body.vercel.detail, /exactly one is expected/);
});

test("no deployment within the deadline is a timeout that names the likely causes", async () => {
  // The Git integration did not fire: App not installed, project unlinked,
  // or the repo disables Git deployments.
  const vercel = { ...established(), gitIntegration: false };
  const { post } = setup({ site: LUCAS_SITE, repos: TOM_REPO, vercel });
  const r = await post({ client_id: CLIENT, branch: "main", message: "Blog: x (Compass CRM)", files: [{ path: "data/blog-posts.json", content: "[]" }] });
  assert.equal(r.status, 200, "the push itself succeeded");
  assert.equal(r.body.vercel.status, "not_found");
  assert.match(r.body.vercel.detail, /created no deployment/);
  assert.match(r.body.vercel.detail, /GitHub App/);
  assert.match(r.body.vercel.detail, /Ignored Build Step/);
  assert.ok(r.body.commit_url, "the commit is still reported as pushed");
});

test("a preview push whose deployment comes back on a production target is reported failed", async () => {
  // Defence in depth. The project has a deployment, so the link guard
  // passes, but its production branch IS the side branch we are pushing —
  // so Vercel returns a production target for a preview push. That must
  // never be reported as a preview.
  const vercel = {
    projects: { "ridge-safety-preview": { id: "prj_p", repo: "Compass2026/ridge-safety", productionBranch: "compass/x", deployments: 1 } },
    deployments: { dpl_seed: { id: "dpl_seed", url: "s.vercel.app", target: "production", state: "READY", readyState: "READY", source: "git", sha: "seed" } },
  };
  const { post } = setup({
    site: { ...LUCAS_SITE, vercel_project: null, work_mode: "new_build", content_adapter: null, content_paths: null },
    repos: { "Compass2026/ridge-safety": { id: 42, default_branch: "main", branches: { main: { author: "Compass CRM" } } } },
    vercel,
  });
  const r = await post({ client_id: CLIENT, branch: "compass/x", message: "build", files: [{ path: "app/page.tsx", content: "x" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vercel.status, "failed");
  assert.equal(r.body.vercel.target, "production");
  assert.match(r.body.vercel.detail, /refusing to report it as a preview/);
});

test("deploy:false is refused, not silently reinterpreted", async () => {
  const { post, gh } = setup({ site: LUCAS_SITE, repos: TOM_REPO, vercel: established() });
  const r = await post({ client_id: CLIENT, branch: "main", message: "x", deploy: false, files: [{ path: "data/blog-posts.json", content: "[]" }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no longer accepted/);
  assert.match(r.body.error, /cannot suppress a deployment/);
  assert.equal(gh.calls.length, 0, "refused before anything is written");
});

test("redeploy with no commit still deploys through the REST API — the one case the Git integration cannot serve", async () => {
  const vercel = established();
  const { post, gh } = setup({ site: LUCAS_SITE, repos: TOM_REPO, vercel });
  const r = await post({ client_id: CLIENT, deploy: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vercel.source, "rest-api");
  assert.equal(r.body.vercel.redeploy, true);
  assert.equal(restPosts(gh).length, 1);
});

test("redeploy refuses while a deployment of the same head is still in flight", async () => {
  const vercel = established();
  const { post, gh, supabase } = setup({ site: LUCAS_SITE, repos: TOM_REPO, vercel });
  // Put an in-flight deployment on the current head.
  const head = Object.values(gh.model["Compass2026/ridge-safety"].commits)[0].sha;
  vercel.deployments.dpl_inflight = { id: "dpl_inflight", url: "x.vercel.app", target: "production", state: "BUILDING", readyState: "BUILDING", source: "git", sha: head };
  const r = await post({ client_id: CLIENT, deploy: true });
  assert.equal(r.body.vercel.status, "skipped");
  assert.match(r.body.vercel.detail, /already deploying/);
  assert.equal(restPosts(gh).length, 0, "no second deployment of the same commit");
  assert.ok(supabase);
});
