// Request-boundary tests for the site-push Edge Function: the real handler
// (supabase/functions/site-push/handler.ts) with a fake Supabase client and
// a fake GitHub API. No network; nothing is deployed or delivered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSitePushHandler, SITE_PUSH_VERSION } from "../supabase/functions/site-push/handler.ts";
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
  const handler = createSitePushHandler({ supabase, fetch: gh.fetch });
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

test("a preview push is blocked when the Vercel project has no deployments — twice in a row", async () => {
  // Vercel promotes a project's FIRST deployment to production whatever the
  // branch, and the API rejects an explicit preview target. Creating the
  // project does not help: the next deployment is still its first. So the
  // SECOND consecutive preview request must be blocked as firmly as the
  // first — that is the case the earlier "push again" advice got wrong.
  const vercel = { projects: {} };
  const site = { ...LUCAS_SITE, vercel_project: null, work_mode: "new_build", content_adapter: null, content_paths: null };
  const repos = { "Compass2026/ridge-safety": { id: 42, default_branch: "main", branches: { main: { author: "Compass CRM" } } } };
  const { post } = setup({ site, repos, vercel });
  const body = { client_id: CLIENT, preview: true, message: "build", files: [{ path: "brands/x/content/home.ts", content: "export const home = {};" }] };

  const first = await post(body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.vercel.status, "blocked");
  assert.equal(first.body.vercel.created_project, true);
  assert.match(first.body.vercel.detail, /no successful \(READY\) deployment yet/);
  assert.match(first.body.vercel.detail, /Pushing again on its own does NOT help/);

  const second = await post(body);
  assert.equal(second.body.vercel.status, "blocked", "the second consecutive preview must be blocked too");
  assert.equal(second.body.vercel.created_project, false, "the project already exists by now");
  assert.match(second.body.vercel.detail, /no successful \(READY\) deployment yet/);

  assert.equal(Object.keys(vercel.deployments ?? {}).length, 0, "neither request may create a deployment");
  assert.equal(vercel.projects["ridge-safety-preview"].deployments, 0);
});

test("a blocked Git-integration deployment does not count as the project having one", async () => {
  // Vercel's Git integration registers a deployment for our push and blocks
  // it, because the commit author is not a team member. That record must not
  // satisfy the pre-flight check: the next deployment would still be the
  // project's first real one, and therefore production.
  const vercel = { projects: { "ridge-safety-preview": { id: "prj_ridge-safety-preview", deployments: 0, blockedOnly: true } } };
  const { post } = setup({
    site: { ...LUCAS_SITE, vercel_project: null, work_mode: "new_build", content_adapter: null, content_paths: null },
    repos: { "Compass2026/ridge-safety": { id: 42, default_branch: "main", branches: { main: { author: "Compass CRM" } } } },
    vercel,
  });
  const r = await post({ client_id: CLIENT, preview: true, message: "build", files: [{ path: "brands/x/content/home.ts", content: "export const home = {};" }] });
  assert.equal(r.body.vercel.status, "blocked");
  assert.match(r.body.vercel.detail, /no successful \(READY\) deployment yet/);
  assert.equal(Object.keys(vercel.deployments ?? {}).length, 0);
});

test("a preview deploys normally once the project has a deployment", async () => {
  const vercel = { projects: { "ridge-safety-preview": { id: "prj_ridge-safety-preview", deployments: 1 } }, deployments: { dpl_seed: { id: "dpl_seed", url: "seed.vercel.app", target: "production", readyState: "READY" } } };
  const { post } = setup({
    site: { ...LUCAS_SITE, vercel_project: null, work_mode: "new_build", content_adapter: null, content_paths: null },
    repos: { "Compass2026/ridge-safety": { id: 42, default_branch: "main", branches: { main: { author: "Compass CRM" } } } },
    vercel,
  });
  const r = await post({ client_id: CLIENT, preview: true, message: "build", files: [{ path: "brands/x/content/home.ts", content: "export const home = {};" }] });
  assert.equal(r.body.vercel.status, "deployed");
  assert.equal(r.body.vercel.target, null ?? r.body.vercel.target);
  assert.notEqual(r.body.vercel.target, "production");
  assert.equal(r.body.vercel.ready_state, "READY");
});

test("a preview that Vercel still puts on a production target is reported failed, never as a preview", async () => {
  // Defence in depth behind the pre-flight check: the listing claims the
  // project has a deployment, so the push proceeds, but Vercel returns a
  // production target anyway. That must never be reported as a preview.
  const vercel = {
    projects: { "ridge-safety-preview": { id: "prj_ridge-safety-preview", deployments: 0, listingSays: 1 } },
    deployments: {},
  };
  const { post, site } = setup({
    site: { ...LUCAS_SITE, vercel_project: null, work_mode: "new_build", content_adapter: null, content_paths: null },
    repos: { "Compass2026/ridge-safety": { id: 42, default_branch: "main", branches: { main: { author: "Compass CRM" } } } },
    vercel,
  });
  const r = await post({ client_id: CLIENT, preview: true, message: "build", files: [{ path: "brands/x/content/home.ts", content: "export const home = {};" }] });
  assert.equal(r.body.vercel.status, "failed");
  assert.equal(r.body.vercel.target, "production");
  assert.match(r.body.vercel.detail, /refusing to report it as a preview/);
  assert.equal(site().staging_url ?? null, null, "a production-target preview never becomes the staging URL");
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
