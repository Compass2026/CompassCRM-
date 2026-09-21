// site-push — commits a built client site to its GitHub repo on the worker's
// behalf.
//
// Why this exists: a Claude Code cloud session reaches github.com only
// through a credential-protecting proxy that permits the repositories attached
// to the session and nothing else. A PAT in the URL never reaches GitHub; the
// proxy refuses first. So the Foundation worker cannot clone or push a client
// repo itself. It can, however, POST the files here, and this function — which
// runs in Supabase, outside any session — creates the repo if needed and
// commits through GitHub's Git Data API with GITHUB_TOKEN from Vault.
//
// Auth: a signed-in team member's JWT, or the x-cron-secret header.
//
// Body:
//   {
//     client_id: uuid,                 required; the sites row is updated
//     repo?: "Compass2026/<slug>",     default: GITHUB_ORG + '/' + slug(client name)
//     branch?: "main",
//     message: "…",                    commit message
//     files: [{ path, content, encoding?: "utf-8" | "base64" }],
//     delete?: [path, …]               paths to remove from the tree
//   }
//
// Files not named in `files` or `delete` are left as they are (the commit is
// built on the branch's current tree). An empty repository gets a root commit.
//
// Response: { repo_url, commit_url, branch, files, deleted, created_repo }.
//
// More modes, all with { client_id } and no files:
//   { read: true, paths? }  — the branch's tree with text files inline
//                           (so the worker, which cannot clone, can edit and
//                           push back only what changed); `paths` limits the
//                           inline contents to those files
//   { domain: "host" }    — add the production domain (and its www / apex
//                           twin as a redirect) to the Vercel project and
//                           report verification state + the DNS records Tom
//                           must add; { status: verified | pending, dns }
//   { revert: true }      — "put it back": a new commit on the branch that
//                           restores the previous commit's tree (nothing is
//                           rewritten; the change stays in history)
//
// Push options (Sept 14 2026, for Tom's Next.js repos): the repo and the
// Vercel project come from the client's `sites` row when set, so a push
// lands in `Compass2026/lucas_construction`. Every commit here — revert,
// empty-repo bootstrap and normal tree alike — carries the single
// CRM_COMMIT_IDENTITY (plan.ts), author AND committer, on a team member's
// address, so Vercel no longer blocks them.
//
// Single deployment path (v10): because those commits are no longer blocked,
// Vercel's own Git integration would deploy each one ALONGSIDE the explicit
// deployment below — twice per push, and on a project with no successful
// deployment the Git one would be promoted to production whatever the
// branch. So every commit also carries `vercel.json` with
// `git.deploymentEnabled: false` (see vercel-config.ts), merged into
// whatever settings the file already holds. It is the first file of an
// empty repository's bootstrap commit and rides atomically in the tree of
// every other push; a request may neither delete it nor re-enable the
// integration, and anything that cannot be read or merged fails closed
// before a commit exists. The deployment is created here explicitly:
// production for the branch of record, a preview for a side branch.
// `deploy: false` skips it.
//
// Branches (v9, Foundation integration — see plan.ts): the BRANCH OF RECORD
// is `sites.branch`, else the repository's default branch, else main; it is
// never assumed to be main. `branch: "compass/<name>"` (or `preview: true`
// for an auto-named branch) creates a side branch FROM the branch of record
// and `pull_request: { title, body }` opens a PR whose base is the branch of
// record; a preview push records `sites.preview_branch` and never moves
// `sites.branch` or starts a production deployment. A site in work mode
// `client_retains` is never pushed to (409). A site row created by a push is
// recorded with the stack the files imply, never astro by default.
//
// Archive mode: { archive: { repo, ref } } streams that repository's tarball
// at that ref through the Vault token — how the worker (which cannot reach
// GitHub) obtains the pinned Foundation source. Only the client's own repo or
// the pinned Foundation release recorded in `foundation_releases` is served.
// `brand` on a push sets COMPASS_BRAND on a Vercel project this call creates.

import { archiveAllowed, CRM_COMMIT_IDENTITY, resolvePushPlan, type SiteRowForPlan } from "./plan.ts";
import {
  buildVercelConfig,
  decodeFileContent,
  guardVercelConfigRequest,
  isVercelConfigPath,
  VERCEL_CONFIG_PATH,
  withVercelConfigFirst,
} from "./vercel-config.ts";

export const SITE_PUSH_VERSION = 10;
export const SITE_PUSH_FEATURES = ["branch_of_record", "preview", "pull_request_base", "archive", "content_entry_boundary", "work_modes", "version", "single_deployment_path"] as const;

type FileIn = { path: string; content: string; encoding?: "utf-8" | "base64" };

// The handler is a factory over its two external dependencies so the request
// boundary can be tested with a fake Supabase client and a fake GitHub
// (tests/site-push-handler.test.mjs). index.ts wires the real ones.
// deno-lint-ignore no-explicit-any
export type SupabaseLike = any;
export interface HandlerDeps {
  supabase: SupabaseLike;
  fetch: typeof fetch;
}

function repoSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 90);
}

export function createSitePushHandler(deps: HandlerDeps) {
  return async (req: Request): Promise<Response> => {
  const supabase = deps.supabase;
  const secret = async (name: string): Promise<string | null> => {
    const { data } = await supabase.rpc("get_secret", { secret_name: name });
    return (data as string | null) || null;
  };

  const cronSecret = await secret("SYNC_CRON_SECRET");
  const isCron =
    req.headers.get("x-cron-secret") &&
    req.headers.get("x-cron-secret") === cronSecret;
  if (!isCron) {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData } = await supabase.auth.getUser(jwt);
    if (!userData?.user) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    // Signed in is not enough once clients have portal logins: team only
    // (matches migration 0036_team_only_access and the deployed function).
    const { data: member } = await supabase
      .from("team_members")
      .select("id")
      .eq("auth_user_id", userData.user.id)
      .maybeSingle();
    if (!member) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const body = await req.json().catch(() => null);
  // deploy: true with no files re-deploys the current head on Vercel without
  // committing anything — the retry path, and how Tom redeploys by hand.
  const deployOnly: boolean = body?.deploy === true && !(Array.isArray(body.files) && body.files.length);
  const readOnly: boolean = body?.read === true;
  const domainOnly: boolean = typeof body?.domain === "string" && body.domain.trim() !== "";
  const revertOnly: boolean = body?.revert === true;
  const archiveReq: { repo: string; ref: string } | null =
    body?.archive && typeof body.archive === "object" && typeof body.archive.repo === "string" && typeof body.archive.ref === "string"
      ? { repo: String(body.archive.repo), ref: String(body.archive.ref) }
      : null;
  const previewRequested: boolean = body?.preview === true;
  // { deployment_status: "<id|url>" } — read-only: what became of a deployment.
  // The worker has no Vercel connector, so this is how it verifies that a
  // preview it pushed actually built instead of taking the push on trust.
  const deploymentStatusReq: string | null =
    typeof body?.deployment_status === "string" && body.deployment_status.trim() ? body.deployment_status.trim() : null;
  const productionBranchHint: string | null = typeof body?.production_branch === "string" ? body.production_branch : null;
  const brandForVercel: string | null = typeof body?.brand === "string" && body.brand.trim() ? body.brand.trim() : null;
  // { version: true } — what is deployed. The worker's preflight compares
  // it with the version its playbook was written for, so a run never
  // executes against a half-installed integration.
  if (body?.version === true) {
    return Response.json({ version: SITE_PUSH_VERSION, features: SITE_PUSH_FEATURES });
  }
  const noDeploy: boolean = body?.deploy === false;
  const readPaths: string[] | null = Array.isArray(body?.paths) ? body.paths.map(String) : null;
  const pullRequest: { title?: string; body?: string } | null =
    body?.pull_request && typeof body.pull_request === "object" ? body.pull_request : null;
  if (!body?.client_id || (!deployOnly && !readOnly && !domainOnly && !revertOnly && !archiveReq && !deploymentStatusReq && (!Array.isArray(body.files) || !body.files.length))) {
    return Response.json(
      { error: "client_id and a non-empty files[] are required (or deploy / read / domain / revert / archive / deployment_status)" },
      { status: 400 }
    );
  }
  const files = (body.files ?? []) as FileIn[];
  const deletes = (body.delete ?? []) as string[];
  const message: string = body.message ?? "Update site from Compass CRM";
  for (const f of files) {
    if (!f.path || typeof f.content !== "string" || f.path.startsWith("/") || f.path.includes("..")) {
      return Response.json({ error: `bad file entry: ${JSON.stringify(f.path)}` }, { status: 400 });
    }
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, name, website_url")
    .eq("id", body.client_id)
    .single();
  if (clientError || !client) {
    return Response.json({ error: clientError?.message ?? "client not found" }, { status: 404 });
  }

  const token = await secret("GITHUB_TOKEN");
  if (!token) {
    return Response.json(
      { error: "GitHub not configured — set GITHUB_TOKEN in Vault (PAT with repo scope)." },
      { status: 500 }
    );
  }
  const org = (await secret("GITHUB_ORG")) ?? "Compass2026";
  const { data: siteRow } = await supabase
    .from("sites")
    .select("id, repo_url, branch, preview_branch, vercel_project, stack, work_mode, controlled_by_compass, content_adapter, content_paths")
    .eq("client_id", client.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const repoFromSite = siteRow?.repo_url?.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  const full: string = body.repo ?? (repoFromSite ? `${repoFromSite[1]}/${repoFromSite[2].replace(/\.git$/, "")}` : `${org}/${repoSlug(client.name)}`);
  const [owner, name] = full.split("/");
  if (!owner || !name) {
    return Response.json({ error: `bad repo "${full}"` }, { status: 400 });
  }

  const gh = async (path: string, init: RequestInit = {}) => {
    const res = await deps.fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "compass-client-platform",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    return res;
  };
  const fail = (step: string, res: Response, text: string) =>
    new Error(`${step} failed (${res.status}): ${text.slice(0, 300)}`);

  // ── Archive mode: the pinned Foundation source (or the client's repo) ──
  if (archiveReq) {
    const { data: release } = await supabase
      .from("foundation_releases")
      .select("source_repo, source_sha")
      .eq("is_current", true)
      .limit(1)
      .maybeSingle();
    const foundation = release ? { repo: String(release.source_repo), sha: String(release.source_sha) } : null;
    if (!archiveAllowed(archiveReq, repoFromSite ? `${repoFromSite[1]}/${repoFromSite[2].replace(/\.git$/, "")}` : null, foundation)) {
      return Response.json(
        { error: `archive refused: only this client's repository or the current Foundation release (${foundation ? `${foundation.repo}@${foundation.sha}` : "none recorded"}) may be fetched` },
        { status: 403 }
      );
    }
    const tar = await gh(`/repos/${archiveReq.repo}/tarball/${archiveReq.ref}`, { redirect: "follow" });
    if (!tar.ok || !tar.body) {
      return Response.json({ error: `archive ${archiveReq.repo}@${archiveReq.ref} failed (${tar.status}): ${(await tar.text()).slice(0, 300)}` }, { status: 502 });
    }
    return new Response(tar.body, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${archiveReq.repo.replace("/", "-")}-${archiveReq.ref.slice(0, 12)}.tar.gz"`,
        "x-archive-repo": archiveReq.repo,
        "x-archive-ref": archiveReq.ref,
      },
    });
  }

  try {
    // ── Ensure the repo ─────────────────────────────────────────────────
    // Compass2026 is a user account, not an organization: a repo under it is
    // created with POST /user/repos. Only a real org takes /orgs/{org}/repos.
    let createdRepo = false;
    let repoUrl: string;
    let repoId: number | null = null; // GitHub's numeric id; Vercel deploys by it
    let repoDefaultBranch: string | null = null; // never assumed to be main
    const head = await gh(`/repos/${owner}/${name}`);
    if (head.ok) {
      const r = await head.json();
      repoUrl = r.html_url;
      repoId = r.id;
      repoDefaultBranch = typeof r.default_branch === "string" ? r.default_branch : null;
    } else if (head.status === 404) {
      const me = await gh(`/user`);
      if (!me.ok) throw fail("whoami", me, await me.text());
      const login: string = (await me.json()).login;
      const isSelf = login.toLowerCase() === owner.toLowerCase();
      const create = await gh(isSelf ? `/user/repos` : `/orgs/${owner}/repos`, {
        method: "POST",
        body: JSON.stringify({
          name,
          private: true,
          auto_init: false,
          description: `${client.name} — Compass Marketing Advisors`,
        }),
      });
      if (!create.ok) {
        const text = await create.text();
        throw fail(
          `repo create under ${isSelf ? "user" : "org"} ${owner} (token is ${login})`,
          create,
          text
        );
      }
      const r = await create.json();
      repoUrl = r.html_url;
      repoId = r.id;
      createdRepo = true;
    } else {
      throw fail("repo lookup", head, await head.text());
    }

    // ── Which branch, and its current head ──────────────────────────────
    // plan.ts decides: the branch of record (never assumed main), whether
    // this is a preview from it, where a pull request points, whether the
    // push may deploy to production, and whether it may move sites.branch.
    const planSite: SiteRowForPlan | null = siteRow
      ? {
          branch: siteRow.branch ?? null,
          stack: (siteRow.stack as SiteRowForPlan["stack"]) ?? null,
          work_mode: (siteRow.work_mode as SiteRowForPlan["work_mode"]) ?? null,
          controlled_by_compass: siteRow.controlled_by_compass ?? null,
          vercel_project: siteRow.vercel_project ?? null,
          content_adapter: (siteRow.content_adapter as string | null) ?? null,
          content_paths: (siteRow.content_paths as SiteRowForPlan["content_paths"]) ?? null,
        }
      : null;

    // 409 from the ref lookup means the repository has no commits at all —
    // distinct from 404, which is a missing branch in a repo that has some.
    let repoEmpty = createdRepo;
    const readHead = async (b: string) => {
      const ref = await gh(`/repos/${owner}/${name}/git/ref/heads/${b}`);
      if (ref.ok) {
        const sha = (await ref.json()).object.sha;
        const commit = await gh(`/repos/${owner}/${name}/git/commits/${sha}`);
        if (!commit.ok) throw fail("read head commit", commit, await commit.text());
        const c = await commit.json();
        return { sha, tree: c.tree.sha as string, authorName: c.author?.name as string | undefined };
      }
      if (ref.status === 409) { repoEmpty = true; return null; }
      if (ref.status === 404) return null;
      throw fail("read ref", ref, await ref.text());
    };

    const requestedBranch: string | null = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : null;
    const baseGuess = planSite?.branch ?? productionBranchHint ?? repoDefaultBranch ?? "main";
    const baseHead = createdRepo ? null : await readHead(baseGuess);
    const plan = resolvePushPlan({
      requestedBranch,
      previewRequested,
      pullRequest: !!pullRequest,
      productionBranchHint,
      siteRow: planSite,
      repoDefaultBranch,
      repoEmpty,
      headAuthorName: baseHead?.authorName ?? null,
      filePaths: files.map((f) => f.path),
      deletePaths: deletes,
      slug: repoSlug(client.name).slice(0, 24) || "site",
    });
    // Read / deploy / domain / revert modes act on the branch of record (or
    // the named branch) and are never refused by the work mode.
    const mutating = !readOnly && !deployOnly && !domainOnly && !revertOnly && !deploymentStatusReq;
    if (mutating && plan.refuse) {
      return Response.json({ error: plan.refuse.error, work_mode: planSite?.work_mode ?? null, branch_of_record: plan.base }, { status: plan.refuse.status });
    }
    const base = plan.base;
    let branch = mutating ? plan.branch : (requestedBranch ?? base);
    let parentSha: string | null = null;
    let baseTree: string | null = null;

    let headInfo = branch === baseGuess ? baseHead : await readHead(branch);
    // A side branch that does not exist yet starts from the branch of record.
    if (!headInfo && mutating && plan.createFrom && !repoEmpty) {
      const fromHead = plan.createFrom === baseGuess ? baseHead : await readHead(plan.createFrom);
      if (fromHead) {
        const mk = await gh(`/repos/${owner}/${name}/git/refs`, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromHead.sha }),
        });
        if (!mk.ok) throw fail(`create branch ${branch} from ${plan.createFrom}`, mk, await mk.text());
        headInfo = fromHead;
      }
    }
    if (headInfo) {
      parentSha = headInfo.sha;
      baseTree = headInfo.tree;
    }

    // ── Revert mode: a new commit carrying the previous commit's tree ───
    if (revertOnly) {
      if (!headInfo) return Response.json({ error: "branch has no commits" }, { status: 400 });
      const cur = await gh(`/repos/${owner}/${name}/git/commits/${headInfo.sha}`);
      if (!cur.ok) throw fail("read head", cur, await cur.text());
      const c = await cur.json();
      const parent = c.parents?.[0]?.sha as string | undefined;
      if (!parent) return Response.json({ error: "the head commit has no parent to go back to" }, { status: 400 });
      const prev = await gh(`/repos/${owner}/${name}/git/commits/${parent}`);
      if (!prev.ok) throw fail("read previous commit", prev, await prev.text());
      const pc = await prev.json();
      const mk = await gh(`/repos/${owner}/${name}/git/commits`, {
        method: "POST",
        body: JSON.stringify({
          message: body.message ?? `Put it back: revert "${String(c.message).split("\n")[0].slice(0, 60)}" (Compass CRM)`,
          tree: pc.tree.sha,
          parents: [headInfo.sha],
          author: CRM_COMMIT_IDENTITY,
          committer: CRM_COMMIT_IDENTITY,
        }),
      });
      if (!mk.ok) throw fail("revert commit", mk, await mk.text());
      const rc = await mk.json();
      const upd = await gh(`/repos/${owner}/${name}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: rc.sha, force: false }),
      });
      if (!upd.ok) throw fail("update ref", upd, await upd.text());
      const commitUrl = `${repoUrl}/commit/${rc.sha}`;
      if (siteRow) {
        await supabase.from("sites").update({ last_pushed_at: new Date().toISOString(), last_commit_url: commitUrl }).eq("id", siteRow.id);
      }
      return Response.json({ repo_url: repoUrl, branch, reverted: headInfo.sha, restored: parent, commit_url: commitUrl });
    }

    // ── Read mode: the pushed tree, text files inline ───────────────────
    if (readOnly) {
      if (!headInfo) {
        return Response.json({ repo_url: repoUrl, branch, files: [], note: "branch has no commits" });
      }
      const treeRes = await gh(`/repos/${owner}/${name}/git/trees/${headInfo.tree}?recursive=1`);
      if (!treeRes.ok) throw fail("read tree", treeRes, await treeRes.text());
      const entries = ((await treeRes.json()).tree as { path: string; type: string; sha: string; size?: number }[])
        .filter((e) => e.type === "blob");
      const textExt = /\.(ts|tsx|js|mjs|cjs|astro|css|scss|md|mdx|json|txt|xml|html|svg|yml|yaml|toml)$/i;
      const skip = /^(node_modules|dist|\.astro|\.next|\.vercel)\//;
      const out: Record<string, unknown>[] = [];
      for (const e of entries) {
        if (skip.test(e.path)) continue;
        if (readPaths && !readPaths.includes(e.path)) { out.push({ path: e.path, size: e.size ?? null }); continue; }
        const isText = textExt.test(e.path) && (e.size ?? 0) <= 200_000;
        if (!isText) {
          out.push({ path: e.path, size: e.size ?? null });
          continue;
        }
        const blob = await gh(`/repos/${owner}/${name}/git/blobs/${e.sha}`);
        if (!blob.ok) throw fail(`read ${e.path}`, blob, await blob.text());
        const b = await blob.json();
        const content = b.encoding === "base64"
          ? new TextDecoder().decode(Uint8Array.from(atob(String(b.content).replace(/\n/g, "")), (c) => c.charCodeAt(0)))
          : String(b.content);
        out.push({ path: e.path, size: e.size ?? null, content });
      }
      return Response.json({ repo_url: repoUrl, branch, head: headInfo.sha, files: out });
    }

    // The Vercel project: the one recorded on the sites row when we are on
    // its branch (Tom's projects are named by hand), else the repo name, or
    // `<repo>-astro` for the side branch.
    // A Next.js site (Tom's) has one project whatever the branch: main
    // deploys to production, a side branch gets a preview deployment.
    // One project per site; the Foundation side branch (a build parked next
    // to someone else's site) gets its own so it never collides.
    const projectName = () =>
      siteRow?.vercel_project && (siteRow.stack === "nextjs" || branch === base)
        ? siteRow.vercel_project
        : branch === base ? name : `${name}-preview`;
    const deployTarget = (): "production" | undefined =>
      branch === base && (!mutating || plan.deployTarget === "production") ? "production" : undefined;
    /** This request asked for a preview, so production is out of bounds for it. */
    const previewPush = mutating && plan.deployTarget === "preview";

    // ── Vercel client, shared by the domain mode and the deploy step ────
    const vercelCtx = async () => {
      const vToken = await secret("VERCEL_TOKEN");
      if (!vToken) return null;
      const teamId = (await secret("VERCEL_TEAM_ID")) ?? "team_JxUWGz1PjUP4jOAqXQqy3YFN";
      const project = projectName();
      const vc = (path: string, init: RequestInit = {}) =>
        deps.fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${teamId}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${vToken}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
        });
      return { vc, project };
    };

    // ── Deployment status: did the thing we pushed actually build? ──────
    if (deploymentStatusReq) {
      const ctx = await vercelCtx();
      if (!ctx) return Response.json({ error: "VERCEL_TOKEN not in Vault" }, { status: 500 });
      const id = deploymentStatusReq.replace(/^https?:\/\//, "");
      const res = await ctx.vc(`/v13/deployments/${encodeURIComponent(id)}`);
      if (!res.ok) {
        return Response.json({ error: `deployment ${id} not found (${res.status})` }, { status: 404 });
      }
      const d = await res.json();
      return Response.json({
        deployment_id: d.id ?? null,
        url: d.url ? `https://${d.url}` : null,
        ready_state: d.readyState ?? d.state ?? null,
        target: d.target ?? "preview",
        error_message: d.errorMessage ?? null,
        error_code: d.errorCode ?? null,
      });
    }

    // ── Domain mode: production domain on the project + DNS to add ──────
    if (domainOnly) {
      const ctx = await vercelCtx();
      if (!ctx) return Response.json({ error: "VERCEL_TOKEN not in Vault" }, { status: 500 });
      const { vc, project } = ctx;
      const host = String(body.domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const apex = host.replace(/^www\./, "");
      const primary = host;
      const twin = host.startsWith("www.") ? apex : `www.${apex}`;
      const existing = await vc(`/v9/projects/${project}`);
      if (!existing.ok) {
        return Response.json(
          { error: `Vercel project ${project} not found — push the site first` },
          { status: 404 }
        );
      }
      const results: Record<string, unknown>[] = [];
      for (const d of [primary, twin]) {
        const add = await vc(`/v10/projects/${project}/domains`, {
          method: "POST",
          body: JSON.stringify(d === primary ? { name: d } : { name: d, redirect: primary, redirectStatusCode: 308 }),
        });
        if (!add.ok && add.status !== 409) throw fail(`add domain ${d}`, add, await add.text());
        const info = await vc(`/v9/projects/${project}/domains/${d}`);
        if (!info.ok) throw fail(`domain ${d}`, info, await info.text());
        const i = await info.json();
        const cfgRes = await vc(`/v6/domains/${d}/config`);
        const cfg = cfgRes.ok ? await cfgRes.json() : {};
        results.push({
          domain: d,
          verified: i.verified === true,
          misconfigured: typeof cfg.misconfigured === "boolean" ? cfg.misconfigured : null,
          verification: i.verification ?? [],
        });
      }
      const dns = results.flatMap((r) => {
        const d = r.domain as string;
        const recs: Record<string, unknown>[] = [];
        recs.push(
          d === apex
            ? { type: "A", name: "@", value: "76.76.21.21", for: d }
            : { type: "CNAME", name: d.slice(0, -(apex.length + 1)), value: "cname.vercel-dns.com", for: d }
        );
        for (const v of r.verification as { type: string; domain: string; value: string; reason?: string }[]) {
          recs.push({ type: v.type, name: v.domain, value: v.value, reason: v.reason ?? null, for: d });
        }
        return recs;
      });
      const live = results.every((r) => r.verified === true && r.misconfigured === false);
      await supabase.from("sites").update({ domain_constant: apex }).eq("client_id", client.id);
      return Response.json({
        repo_url: repoUrl,
        branch,
        project,
        domain: primary,
        status: live ? "verified" : "pending",
        domains: results,
        dns,
      });
    }

    // ── Vercel: a project linked to the repo, and a production deployment ──
    // Best-effort and last: a Vercel failure never undoes a successful push.
    // VERCEL_TOKEN in Vault turns it on; VERCEL_TEAM_ID overrides the team.
    // The side branch gets its own project so it never collides with an
    // existing site's project on the same repo.
    const vercelStep = async (commitSha?: string | null): Promise<Record<string, unknown>> => {
      if (noDeploy) return { status: "skipped", detail: "deploy: false — Vercel's Git integration deploys the push" };
      const vToken = await secret("VERCEL_TOKEN");
      if (!vToken) return { status: "skipped", detail: "VERCEL_TOKEN not in Vault" };
      const teamId = (await secret("VERCEL_TEAM_ID")) ?? "team_JxUWGz1PjUP4jOAqXQqy3YFN";
      const project = projectName();
      const vc = (path: string, init: RequestInit = {}) =>
        deps.fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${teamId}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${vToken}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
        });
      try {
        let created = false;
        let projectId: string | null = null;
        const existing = await vc(`/v9/projects/${project}`);
        if (existing.status === 404) {
          const framework = (siteRow?.stack ?? plan.stackForInsert) === "astro" ? "astro" : (siteRow?.stack ?? plan.stackForInsert) === "nextjs" ? "nextjs" : null;
          const mk = await vc(`/v10/projects`, {
            method: "POST",
            body: JSON.stringify({
              name: project,
              ...(framework ? { framework } : {}),
              gitRepository: { type: "github", repo: `${owner}/${name}` },
              ...(brandForVercel
                ? { environmentVariables: [{ key: "COMPASS_BRAND", value: brandForVercel, target: ["production", "preview"], type: "plain" }] }
                : {}),
            }),
          });
          if (!mk.ok) throw fail("vercel project create", mk, await mk.text());
          created = true;
          projectId = (await mk.json())?.id ?? null;
        } else if (!existing.ok) {
          throw fail("vercel project lookup", existing, await existing.text());
        } else {
          projectId = (await existing.json())?.id ?? null;
        }

        // ── A preview may never be a project's FIRST deployment ───────────
        // Vercel promotes a project's first deployment to production whatever
        // the branch, and the API rejects an explicit `target: "preview"`
        // ("should be 'production', 'staging', or a custom environment
        // identifier"), so a preview cannot be asked for directly. Creating
        // the project does NOT help: the next deployment is still its first.
        // The only safe move is to look before deploying and refuse when the
        // project has nothing yet — a production deployment that should not
        // exist cannot be undone by reporting it afterwards.
        if (previewPush) {
          // READY only. Vercel's own Git integration registers deployments
          // for our pushes and then BLOCKS them (our commit author is not a
          // team member), and a blocked or errored record is not a real
          // deployment: counting it would let the next preview through and
          // that one would be the project's first real — production —
          // deployment. Seen live on Sept 21 2026.
          const probe = await vc(`/v6/deployments?projectId=${encodeURIComponent(projectId ?? project)}&state=READY&limit=1`);
          const list = probe.ok ? ((await probe.json())?.deployments ?? null) : null;
          if (!Array.isArray(list)) {
            return {
              status: "blocked",
              project,
              created_project: created,
              detail:
                `Could not confirm whether Vercel project ${project} already has a successful deployment (${probe.status}). Refusing to deploy: a preview that turns out to be this project's first deployment becomes a PRODUCTION deployment. Next action: check the project in Vercel and re-run once it has a deployment.`,
            };
          }
          if (list.length === 0) {
            return {
              status: "blocked",
              project,
              created_project: created,
              detail:
                `Vercel project ${project} has no successful (READY) deployment yet, so this preview would be its first real one — and Vercel promotes a first deployment to production whatever the branch. Nothing was deployed. Next action: give the project its first PRODUCTION deployment deliberately (Vercel → ${project} → deploy the branch of record ${base}), then re-run this push and it will deploy as a preview. A fictional or demonstration brand must never have a production deployment, so a preview is not available for one at all — verify it from the local build instead. Pushing again on its own does NOT help: the next deployment would still be the project's first.`,
            };
          }
        }
        if (!repoId) throw new Error("no GitHub repo id for the deployment");
        // The deployment is created here explicitly rather than left to
        // Vercel's Git integration: production for the branch of record, a
        // preview for a side branch / pull request. (Commits carry
        // CRM_COMMIT_IDENTITY, a team member's address, so the Git
        // integration no longer blocks them either.)
        const target = deployTarget();
        const dep = await vc(`/v13/deployments`, {
          method: "POST",
          body: JSON.stringify({
            name: project,
            project,
            ...(target ? { target } : {}),
            gitSource: { type: "github", repoId, ref: branch },
          }),
        });
        if (!dep.ok) throw fail("vercel deployment", dep, await dep.text());
        const d = await dep.json();
        // Wait briefly for the deployment to settle. A misconfigured build
        // (a tree with no framework, say) errors within seconds, and the
        // caller must hear that rather than record an unbuilt preview as
        // delivered. A healthy build is still BUILDING when we give up.
        let settled: Record<string, unknown> = d;
        const deadline = Date.now() + 45_000;
        while (d.id && Date.now() < deadline) {
          const st = String(settled.readyState ?? settled.state ?? "");
          if (st === "READY" || st === "ERROR" || st === "CANCELED") break;
          await new Promise((r) => setTimeout(r, 4000));
          const poll = await vc(`/v13/deployments/${d.id}`);
          if (!poll.ok) break;
          settled = await poll.json();
        }
        const readyState = String(settled.readyState ?? settled.state ?? "QUEUED");
        const finalTarget = (settled.target ?? d.target ?? null) as string | null;
        // The boundary: a preview push may never end up on a production target.
        if (previewPush && finalTarget === "production") {
          return {
            status: "failed",
            project,
            target: finalTarget,
            deployment_url: d.url ? `https://${d.url}` : null,
            ready_state: readyState,
            detail:
              "a preview push produced a PRODUCTION-target deployment — refusing to report it as a preview. Nothing may be published this way.",
          };
        }
        const stagingUrl = target ? `https://${project}.vercel.app` : (d.url ? `https://${d.url}` : `https://${project}.vercel.app`);
        // ── Defence in depth: one commit, one deployment ────────────────
        // vercel.json git.deploymentEnabled:false is what actually keeps
        // Vercel's Git integration from deploying this commit as well. If a
        // repository ever slips through without it, the symptom is two
        // deployment records for one SHA — so look, and say so. A failure to
        // look is reported, never treated as "none found".
        let duplicates: Record<string, unknown> | null = null;
        if (commitSha) {
          const dupes = await vc(`/v6/deployments?projectId=${encodeURIComponent(projectId ?? project)}&sha=${encodeURIComponent(commitSha)}&limit=10`);
          if (!dupes.ok) {
            duplicates = { checked: false, detail: `could not list deployments for ${commitSha} (${dupes.status})` };
          } else {
            const list = ((await dupes.json())?.deployments ?? []) as { id: string; source?: string; target?: string | null }[];
            const others = list.filter((x) => x.id !== d.id);
            duplicates = others.length > 0
              ? {
                  checked: true,
                  count: list.length,
                  ours: d.id,
                  others: others.map((x) => ({ id: x.id, source: x.source ?? null, target: x.target ?? null })),
                  detail: `Vercel holds ${list.length} deployments for commit ${commitSha}. site-push must be the only deployment path — check that vercel.json on ${branch} carries git.deploymentEnabled:false.`,
                }
              : { checked: true, count: list.length, ours: d.id };
          }
        }
        return {
          ...(duplicates ? { duplicates } : {}),
          status: readyState === "ERROR" ? "failed" : created ? "created" : "deployed",
          project,
          target: finalTarget ?? "preview",
          ready_state: readyState,
          error_message: settled.errorMessage ?? null,
          staging_url: stagingUrl,
          deployment_url: d.url ? `https://${d.url}` : null,
          inspector_url: d.inspectorUrl ?? null,
        };
      } catch (e) {
        return { status: "failed", detail: e instanceof Error ? e.message : String(e) };
      }
    };

    if (deployOnly) {
      const vercel = await vercelStep();
      if ((vercel.status === "created" || vercel.status === "deployed") && vercel.target === "production") {
        await supabase
          .from("sites")
          .update({ vercel_project: vercel.project, staging_url: vercel.staging_url })
          .eq("client_id", client.id);
      }
      return Response.json({ repo_url: repoUrl, branch, deploy_only: true, vercel },
        { status: vercel.status === "failed" ? 502 : 200 });
    }

    // ── vercel.json: the CRM's single deployment path, enforced in-repo ──
    // Every commit site-push makes carries git.deploymentEnabled:false, so
    // Vercel's Git integration never deploys a commit alongside the explicit
    // deployment below. This runs AFTER resolvePushPlan on purpose: the plan
    // (and validateContentEntry with it) judges the CALLER's paths, so a
    // content entry on an upgrade_existing branch of record is still held to
    // its adapter's push paths. vercel.json is CRM infrastructure riding
    // along, not caller content.
    //
    // Everything here fails closed — no commit and no deployment — because a
    // push that lands without the property is a push Vercel may deploy twice.
    const configGuard = guardVercelConfigRequest(files, deletes);
    if (!configGuard.ok) {
      return Response.json({ error: configGuard.error, vercel_config: "refused" }, { status: 409 });
    }
    let existingConfig: string | null = null;
    const suppliedConfig = files.find((f) => isVercelConfigPath(f.path));
    if (suppliedConfig) {
      // The caller's own file is the base to merge into, so its settings win
      // over whatever is on the branch.
      try {
        existingConfig = decodeFileContent(suppliedConfig);
      } catch (e) {
        return Response.json({ error: `the supplied vercel.json could not be decoded (${e instanceof Error ? e.message : String(e)})`, vercel_config: "refused" }, { status: 409 });
      }
    } else if (headInfo) {
      const cur = await gh(`/repos/${owner}/${name}/contents/${VERCEL_CONFIG_PATH}?ref=${encodeURIComponent(headInfo.sha)}`);
      if (cur.ok) {
        const c = await cur.json();
        if (Array.isArray(c) || typeof c.content !== "string") {
          return Response.json({ error: "vercel.json on the branch is not a readable file — refusing to commit without it", vercel_config: "refused" }, { status: 409 });
        }
        try {
          existingConfig = new TextDecoder().decode(
            Uint8Array.from(atob(String(c.content).replace(/\s/g, "")), (ch) => ch.charCodeAt(0)),
          );
        } catch (e) {
          return Response.json({ error: `vercel.json on the branch could not be decoded (${e instanceof Error ? e.message : String(e)})`, vercel_config: "refused" }, { status: 409 });
        }
      } else if (cur.status !== 404) {
        // Could not establish the current state: do not commit.
        return Response.json(
          { error: `could not read vercel.json from ${branch} (${cur.status}) — refusing to push without confirming Vercel's Git integration stays disabled`, vercel_config: "refused" },
          { status: 502 },
        );
      }
    }
    const builtConfig = buildVercelConfig(existingConfig);
    if (!builtConfig.ok) {
      return Response.json({ error: builtConfig.error, vercel_config: "refused" }, { status: 409 });
    }
    // First in the list: for an empty repository the first entry is the
    // bootstrap commit, so the integration is off before any other file
    // exists for Vercel to react to.
    const pushFiles = withVercelConfigFirst(files, builtConfig.content);

    // ── Empty repository: seed the first commit through the Contents API ──
    // The Git Data API refuses to create blobs until a repo has a commit
    // ("Git Repository is empty"); the Contents API does not mind. Write the
    // first file that way, then continue with the rest below.
    let pending = pushFiles;
    let bootstrapCommit: { sha: string; url: string } | null = null;
    if (repoEmpty) {
      const first = pushFiles[0];
      const b64 = first.encoding === "base64"
        ? first.content
        : btoa(Array.from(new TextEncoder().encode(first.content), (b) => String.fromCharCode(b)).join(""));
      const put = await gh(`/repos/${owner}/${name}/contents/${first.path}`, {
        method: "PUT",
        body: JSON.stringify({
          message,
          content: b64,
          branch,
          author: CRM_COMMIT_IDENTITY,
          committer: CRM_COMMIT_IDENTITY,
        }),
      });
      if (!put.ok) throw fail(`bootstrap ${first.path}`, put, await put.text());
      const p = await put.json();
      parentSha = p.commit.sha;
      baseTree = p.commit.tree.sha;
      bootstrapCommit = { sha: p.commit.sha, url: p.commit.html_url };
      pending = pushFiles.slice(1);
    }

    // ── Tree → commit → ref ─────────────────────────────────────────────
    // Text files go INLINE in the one tree request (the Trees API accepts
    // `content` for UTF-8 blobs); only binaries need a blob each. One blob
    // per file tripped GitHub's secondary rate limit (about 80 content-
    // creating requests a minute) on the first 250-file Foundation build
    // (Sept 20 2026), so binaries are also paced.
    let commit: { sha: string } | null = null;
    const tree: Record<string, unknown>[] = [];
    let blobsMade = 0;
    for (const f of pending) {
      if ((f.encoding ?? "utf-8") !== "base64") {
        tree.push({ path: f.path, mode: "100644", type: "blob", content: f.content });
        continue;
      }
      if (blobsMade > 0 && blobsMade % 40 === 0) await new Promise((r) => setTimeout(r, 1500));
      const blob = await gh(`/repos/${owner}/${name}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: f.content, encoding: "base64" }),
      });
      if (!blob.ok) throw fail(`blob ${f.path}`, blob, await blob.text());
      blobsMade++;
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: (await blob.json()).sha });
    }
    for (const p of deletes) {
      if (baseTree) tree.push({ path: p, mode: "100644", type: "blob", sha: null });
    }

    if (tree.length > 0) {
      const treeRes = await gh(`/repos/${owner}/${name}/git/trees`, {
        method: "POST",
        body: JSON.stringify(baseTree ? { base_tree: baseTree, tree } : { tree }),
      });
      if (!treeRes.ok) throw fail("tree", treeRes, await treeRes.text());
      const treeSha = (await treeRes.json()).sha;

      const commitRes = await gh(`/repos/${owner}/${name}/git/commits`, {
        method: "POST",
        body: JSON.stringify({
          message,
          tree: treeSha,
          parents: parentSha ? [parentSha] : [],
          author: CRM_COMMIT_IDENTITY,
          committer: CRM_COMMIT_IDENTITY,
        }),
      });
      if (!commitRes.ok) throw fail("commit", commitRes, await commitRes.text());
      commit = await commitRes.json();

      const refRes = parentSha
        ? await gh(`/repos/${owner}/${name}/git/refs/heads/${branch}`, {
            method: "PATCH",
            body: JSON.stringify({ sha: commit!.sha, force: false }),
          })
        : await gh(`/repos/${owner}/${name}/git/refs`, {
            method: "POST",
            body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit!.sha }),
          });
      if (!refRes.ok) throw fail("update ref", refRes, await refRes.text());
    } else if (bootstrapCommit) {
      commit = { sha: bootstrapCommit.sha };
    } else {
      throw new Error("nothing to commit");
    }

    // ── Pull request for a side branch ──────────────────────────────────
    let prUrl: string | null = null;
    if (pullRequest && branch !== base) {
      const existing = await gh(`/repos/${owner}/${name}/pulls?head=${owner}:${branch}&base=${encodeURIComponent(plan.prBase)}&state=open`);
      const open = existing.ok ? ((await existing.json()) as { html_url: string }[]) : [];
      if (open[0]) prUrl = open[0].html_url;
      else {
        const pr = await gh(`/repos/${owner}/${name}/pulls`, {
          method: "POST",
          body: JSON.stringify({
            title: pullRequest.title ?? message,
            body: pullRequest.body ?? "Opened by the Compass CRM worker.",
            head: branch,
            base: plan.prBase,
          }),
        });
        if (!pr.ok) throw fail("pull request", pr, await pr.text());
        prUrl = (await pr.json()).html_url;
      }
    }

    // ── Record it ───────────────────────────────────────────────────────
    if (!commit) throw new Error("nothing to commit");
    const commitUrl = `${repoUrl}/commit/${commit.sha}`;
    const branchUrl = `${repoUrl}/tree/${branch}`;
    const { data: site } = await supabase
      .from("sites")
      .select("id, repo_url")
      .eq("client_id", client.id)
      .limit(1)
      .maybeSingle();
    if (site) {
      await supabase
        .from("sites")
        .update({
          repo_url: site.repo_url ?? repoUrl,
          // A preview / pull-request push lives on a side branch; the site's
          // branch of record does not move until Tom merges it.
          ...(plan.recordAsBranchOfRecord ? { branch } : {}),
          ...(plan.recordAsPreviewBranch ? { preview_branch: branch } : {}),
          last_pushed_at: new Date().toISOString(),
          last_commit_url: commitUrl,
        })
        .eq("id", site.id);
    } else {
      // No row yet: record what the push implies. The stack comes from the
      // files (never astro by default); the branch of record is the branch
      // this push landed on only when it IS the branch of record.
      await supabase.from("sites").insert({
        client_id: client.id,
        url: client.website_url,
        stack: plan.stackForInsert,
        controlled_by_compass: true,
        repo_url: repoUrl,
        branch: plan.recordAsBranchOfRecord ? branch : base,
        ...(plan.recordAsPreviewBranch ? { preview_branch: branch } : {}),
        work_mode: "new_build",
        last_pushed_at: new Date().toISOString(),
        last_commit_url: commitUrl,
      });
    }

    const vercel = await vercelStep(commit.sha);
    if ((vercel.status === "created" || vercel.status === "deployed") && vercel.target === "production") {
      await supabase
        .from("sites")
        .update({ vercel_project: vercel.project, staging_url: vercel.staging_url })
        .eq("client_id", client.id);
    }

    return Response.json({
      repo_url: repoUrl,
      branch,
      branch_url: branchUrl,
      commit_url: commitUrl,
      files: pushFiles.length,
      deleted: baseTree ? deletes.length : 0,
      created_repo: createdRepo,
      pull_request_url: prUrl,
      branch_of_record: base,
      pull_request_base: pullRequest ? plan.prBase : undefined,
      target: plan.deployTarget,
      grant: plan.grant,
      vercel,
      note: plan.note ?? undefined,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
};
}
