// site-push v12: explicit releases. A site whose Vercel project is not linked
// to Git (content_paths.vercel_deploy = "explicit", the Show Me Electrical
// shape) gets exactly one deployment from site-push for an authorised content
// entry, and only while production serves the commit the entry builds on.
// The real handler with a fake Supabase, the fake GitHub and a small fake
// Vercel; nothing is deployed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSitePushHandler, SITE_PUSH_VERSION } from "../supabase/functions/site-push/handler.ts";
import { fakeSupabase, fakeGitHub } from "./helpers/fakes.mjs";

const CLIENT = "00000000-0000-4000-8000-0000000000c2";
const REPO = "Compass2026/sme-site";
const PROJECT = "sme-main";
const BRANCH = "claude/template-completion";
const POSTS = "brands/showme/content/blog/compass-posts.ts";
const IMAGE = "public/blog/images/a-post-0123456789ab.webp";
const SITE = {
  url: "https://sme.example", stack: "nextjs", controlled_by_compass: true, repo_url: `https://github.com/${REPO}`, branch: BRANCH, preview_branch: null,
  vercel_project: PROJECT, work_mode: "new_build", content_adapter: "foundation_brand_content",
  content_paths: { adapter: "foundation_brand_content", brand: "showme", content_dir: "brands/showme/content", blog_route: "/blog/{slug}", blog_format: "typescript",
    posts_file: POSTS, blog_images: "public/blog/images", vercel_deploy: "explicit" },
};
const REPOS = { [REPO]: { id: 77, default_branch: "careers", branches: { careers: { author: "Tom" }, [BRANCH]: { author: "Tom" } } } };

function setup({ site = SITE, token = true, linked = false, liveSha = "head", liveTarget = "production" } = {}) {
  const supabase = fakeSupabase({
    secrets: { SYNC_CRON_SECRET: "cron", GITHUB_TOKEN: "ghp_fake", ...(token ? { VERCEL_TOKEN: "vt_fake" } : {}) },
    tables: { clients: [{ id: CLIENT, name: "SME Test", website_url: "https://sme.example" }], sites: [{ id: "site-sme", client_id: CLIENT, ...site }] },
  });
  const gh = fakeGitHub({ repos: REPOS });
  const vercel = { created: [], deployments: {} };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const head = () => gh.model[REPO].refs[BRANCH];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host !== "api.vercel.com") return gh.fetch(url, init);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === `/v9/projects/${PROJECT}`) {
      return json(200, { id: "prj_sme", name: PROJECT, ...(linked ? { link: { type: "github", repo: "sme-site", productionBranch: BRANCH } } : {}) });
    }
    if (u.pathname === `/v13/deployments/${encodeURIComponent(`${PROJECT}.vercel.app`)}`) {
      return json(200, { id: "dpl_live", target: liveTarget, readyState: "READY", project: { id: "prj_sme" },
        meta: { githubCommitSha: liveSha === "head" ? head() : liveSha } });
    }
    if (u.pathname === "/v6/deployments" && method === "GET") {
      const sha = u.searchParams.get("sha");
      return json(200, { deployments: Object.values(vercel.deployments).filter((d) => d.meta.githubCommitSha === sha) });
    }
    if (u.pathname === "/v13/deployments" && method === "POST") {
      const id = `dpl_new${vercel.created.length + 1}`;
      vercel.created.push(body);
      vercel.deployments[id] = { id, url: `${PROJECT}-${id}.vercel.app`, target: body.target, readyState: "BUILDING", state: "BUILDING",
        meta: { githubCommitSha: body.gitSource.sha }, polls: 0 };
      return json(200, vercel.deployments[id]);
    }
    const m = u.pathname.match(/^\/v13\/deployments\/(dpl_[^/]+)$/);
    if (m && vercel.deployments[m[1]]) {
      const d = vercel.deployments[m[1]];
      if (++d.polls >= 2) { d.readyState = "READY"; d.state = "READY"; }
      return json(200, d);
    }
    return json(404, { message: `unhandled vercel ${method} ${u.pathname}` });
  };
  const handler = createSitePushHandler({ supabase, fetch, timing: { findMs: 200, settleMs: 200, pollMs: 5 } });
  const post = async (b) => {
    const res = await handler(new Request("https://fn.local/site-push", { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "cron" }, body: JSON.stringify(b) }));
    return { status: res.status, body: await res.json() };
  };
  return { post, gh, vercel, head };
}
// (The fake GitHub's SHAs are not 40-hex, so expected_head is not sent here;
// the publisher's expected-head check is covered in site-push-handler.test.mjs.)
const entry = () => ({ client_id: CLIENT, branch: BRANCH, message: "Publish approved blog a-post",
  files: [{ path: POSTS, content: "export const compassPosts = /* compass:begin */ [] /* compass:end */;" }, { path: IMAGE, content: "UklGRg==", encoding: "base64" }] });

test("version 12 advertises explicit releases", async () => {
  const { post } = setup();
  const r = await post({ client_id: CLIENT, version: true });
  assert.equal(r.body.version, SITE_PUSH_VERSION);
  assert.ok(SITE_PUSH_VERSION >= 12);
  assert.ok(r.body.features.includes("explicit_release"));
});

test("a content entry on an unlinked project: one commit, then exactly one production deployment of that commit", async () => {
  const { post, gh, vercel, head } = setup();
  const before = head();
  const r = await post(entry());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.grant, "content_entry");
  const sha = head();
  assert.notEqual(sha, before);
  assert.equal(gh.model[REPO].commits[sha].parents[0], before, "the entry builds on the head production serves");
  assert.equal(vercel.created.length, 1, "exactly one deployment");
  assert.deepEqual(vercel.created[0], { name: PROJECT, project: PROJECT, target: "production", gitSource: { type: "github", repoId: 77, ref: BRANCH, sha } });
  assert.equal(r.body.vercel.status, "deployed");
  assert.equal(r.body.vercel.ready_state, "READY");
  assert.equal(r.body.vercel.target, "production");
  assert.equal(r.body.vercel.explicit_release, true);
  assert.equal(r.body.vercel.deployment_id, "dpl_new1");
  assert.match(r.body.commit_url, new RegExp(`/commit/${sha}$`));
  assert.ok(!gh.calls.some((c) => c.method !== "GET" && c.path.includes("/careers")), "the careers branch is never touched");
});

test("production behind the branch head: refused before anything is pushed (it would ship unreleased code)", async () => {
  const { post, gh, vercel, head } = setup({ liveSha: "0".repeat(40) });
  const before = head();
  const r = await post(entry());
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Release claude\/template-completion through the site's deployment plan first/);
  assert.equal(head(), before);
  assert.equal(gh.writes().length, 0);
  assert.equal(vercel.created.length, 0);
});

test("refused before the push: a linked project, a preview-target alias, no Vercel token, or a code change", async () => {
  for (const [name, opts, re] of [
    ["linked", { linked: true }, /linked to Git/],
    ["alias not production", { liveTarget: null }, /not served by a READY production deployment/],
    ["no token", { token: false }, /VERCEL_TOKEN is not in Vault/],
  ]) {
    const { post, gh, vercel } = setup(opts);
    const r = await post(entry());
    assert.equal(r.status, 409, name);
    assert.match(r.body.error, re, name);
    assert.equal(gh.writes().length, 0, name);
    assert.equal(vercel.created.length, 0, name);
  }
  const { post, gh, vercel } = setup();
  const code = await post({ client_id: CLIENT, branch: BRANCH, files: [{ path: "components/site/ArticleLayout.tsx", content: "x" }] });
  assert.ok(code.status >= 400);
  assert.equal(vercel.created.length, 0);
  assert.equal(gh.writes().filter((w) => w.path?.includes(`heads/${BRANCH}`)).length, 0);
});

test("deploy-only (Redeploy) never deploys an explicitly released project", async () => {
  const { post, vercel } = setup();
  const r = await post({ client_id: CLIENT, deploy: true });
  assert.equal(r.body.vercel.status, "skipped");
  assert.match(r.body.vercel.detail, /released explicitly/);
  assert.equal(vercel.created.length, 0);
});

test("Put it back on an explicitly released site: the revert commit is deployed once, the same way", async () => {
  const { post, vercel, head } = setup();
  const published = await post(entry());
  assert.equal(published.status, 200, JSON.stringify(published.body));
  // production now serves the published commit (the fake alias follows the head)
  const r = await post({ client_id: CLIENT, revert: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(vercel.created.length, 2);
  assert.equal(vercel.created[1].gitSource.sha, head());
  assert.equal(r.body.vercel.status, "deployed");
});
