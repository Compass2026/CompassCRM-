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
// lands in `Compass2026/lucas_construction` and Vercel's own Git
// integration would deploy it, except that Vercel blocks Git deployments
// whose commit author is not a team member (ours is "Compass CRM"), so the
// deployment is always created here: production for the branch of record,
// a preview for a side branch. `deploy: false` skips it. `branch: "compass/<name>"` creates the branch from `main` if
// it does not exist, and `pull_request: { title, body }` opens a PR to
// `main` for it (the path for hand-built pages the stage may not push to
// directly).

import { createClient } from "npm:@supabase/supabase-js@2";

type FileIn = { path: string; content: string; encoding?: "utf-8" | "base64" };

function repoSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 90);
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
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
  }

  const body = await req.json().catch(() => null);
  // deploy: true with no files re-deploys the current head on Vercel without
  // committing anything — the retry path, and how Tom redeploys by hand.
  const deployOnly: boolean = body?.deploy === true && !(Array.isArray(body.files) && body.files.length);
  const readOnly: boolean = body?.read === true;
  const domainOnly: boolean = typeof body?.domain === "string" && body.domain.trim() !== "";
  const revertOnly: boolean = body?.revert === true;
  const noDeploy: boolean = body?.deploy === false;
  const readPaths: string[] | null = Array.isArray(body?.paths) ? body.paths.map(String) : null;
  const pullRequest: { title?: string; body?: string } | null =
    body?.pull_request && typeof body.pull_request === "object" ? body.pull_request : null;
  if (!body?.client_id || (!deployOnly && !readOnly && !domainOnly && !revertOnly && (!Array.isArray(body.files) || !body.files.length))) {
    return Response.json(
      { error: "client_id and a non-empty files[] are required (or deploy / read / domain / revert)" },
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
    .select("id, repo_url, branch, vercel_project, stack")
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
    const res = await fetch(`https://api.github.com${path}`, {
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

  try {
    // ── Ensure the repo ─────────────────────────────────────────────────
    // Compass2026 is a user account, not an organization: a repo under it is
    // created with POST /user/repos. Only a real org takes /orgs/{org}/repos.
    let createdRepo = false;
    let repoUrl: string;
    let repoId: number | null = null; // GitHub's numeric id; Vercel deploys by it
    const head = await gh(`/repos/${owner}/${name}`);
    if (head.ok) {
      const r = await head.json();
      repoUrl = r.html_url;
      repoId = r.id;
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
    // A repo whose main already carries someone else's work (Pensacola has
    // a hand-built Next.js site on main) is never overwritten: the build
    // goes to `compass-astro` instead, and the caller is told which.
    const requested: string | null = body.branch ?? (siteRow?.stack === "nextjs" ? (siteRow.branch ?? "main") : null);
    let branch = requested ?? "main";
    let parentSha: string | null = null;
    let baseTree: string | null = null;

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

    let headInfo = await readHead(branch);
    if (!requested && headInfo && headInfo.authorName !== "Compass CRM") {
      branch = "compass-astro";
      headInfo = await readHead(branch); // null → an orphan branch with only our tree
    }
    // A requested side branch that does not exist yet starts from main.
    if (!headInfo && requested && requested !== "main" && !repoEmpty) {
      const mainHead = await readHead("main");
      if (mainHead) {
        const mk = await gh(`/repos/${owner}/${name}/git/refs`, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${requested}`, sha: mainHead.sha }),
        });
        if (!mk.ok) throw fail(`create branch ${requested}`, mk, await mk.text());
        headInfo = mainHead;
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
          author: { name: "Compass CRM", email: "crm@compassmarketing.ai" },
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
    const projectName = () =>
      siteRow?.vercel_project && (siteRow.stack === "nextjs" || branch === (siteRow.branch ?? "main"))
        ? siteRow.vercel_project
        : branch === "main" ? name : `${name}-astro`;
    const deployTarget = (): "production" | undefined =>
      branch === (siteRow?.branch ?? "main") ? "production" : undefined;

    // ── Vercel client, shared by the domain mode and the deploy step ────
    const vercelCtx = async () => {
      const vToken = await secret("VERCEL_TOKEN");
      if (!vToken) return null;
      const teamId = (await secret("VERCEL_TEAM_ID")) ?? "team_JxUWGz1PjUP4jOAqXQqy3YFN";
      const project = projectName();
      const vc = (path: string, init: RequestInit = {}) =>
        fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${teamId}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${vToken}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
        });
      return { vc, project };
    };

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
    const vercelStep = async (): Promise<Record<string, unknown>> => {
      if (noDeploy) return { status: "skipped", detail: "deploy: false — Vercel's Git integration deploys the push" };
      const vToken = await secret("VERCEL_TOKEN");
      if (!vToken) return { status: "skipped", detail: "VERCEL_TOKEN not in Vault" };
      const teamId = (await secret("VERCEL_TEAM_ID")) ?? "team_JxUWGz1PjUP4jOAqXQqy3YFN";
      const project = projectName();
      const vc = (path: string, init: RequestInit = {}) =>
        fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${teamId}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${vToken}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
        });
      try {
        let created = false;
        const existing = await vc(`/v9/projects/${project}`);
        if (existing.status === 404) {
          const mk = await vc(`/v10/projects`, {
            method: "POST",
            body: JSON.stringify({
              name: project,
              framework: siteRow?.stack === "nextjs" ? "nextjs" : "astro",
              gitRepository: { type: "github", repo: `${owner}/${name}` },
            }),
          });
          if (!mk.ok) throw fail("vercel project create", mk, await mk.text());
          created = true;
        } else if (!existing.ok) {
          throw fail("vercel project lookup", existing, await existing.text());
        }
        if (!repoId) throw new Error("no GitHub repo id for the deployment");
        // Vercel's Git integration blocks commits from authors who are not
        // team members (ours are "Compass CRM"), so the deployment is created
        // here explicitly: production for the branch of record, a preview
        // for a side branch / pull request.
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
        const stagingUrl = target ? `https://${project}.vercel.app` : (d.url ? `https://${d.url}` : `https://${project}.vercel.app`);
        return {
          status: created ? "created" : "deployed",
          project,
          target: target ?? "preview",
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

    // ── Empty repository: seed the first commit through the Contents API ──
    // The Git Data API refuses to create blobs until a repo has a commit
    // ("Git Repository is empty"); the Contents API does not mind. Write the
    // first file that way, then continue with the rest below.
    let pending = files;
    let bootstrapCommit: { sha: string; url: string } | null = null;
    if (repoEmpty) {
      const first = files[0];
      const b64 = first.encoding === "base64"
        ? first.content
        : btoa(Array.from(new TextEncoder().encode(first.content), (b) => String.fromCharCode(b)).join(""));
      const put = await gh(`/repos/${owner}/${name}/contents/${first.path}`, {
        method: "PUT",
        body: JSON.stringify({
          message,
          content: b64,
          branch,
          committer: { name: "Compass CRM", email: "crm@compassmarketing.ai" },
        }),
      });
      if (!put.ok) throw fail(`bootstrap ${first.path}`, put, await put.text());
      const p = await put.json();
      parentSha = p.commit.sha;
      baseTree = p.commit.tree.sha;
      bootstrapCommit = { sha: p.commit.sha, url: p.commit.html_url };
      pending = files.slice(1);
    }

    // ── Blobs → tree → commit → ref ─────────────────────────────────────
    let commit: { sha: string } | null = null;
    const tree: Record<string, unknown>[] = [];
    for (const f of pending) {
      const blob = await gh(`/repos/${owner}/${name}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: f.content, encoding: f.encoding ?? "utf-8" }),
      });
      if (!blob.ok) throw fail(`blob ${f.path}`, blob, await blob.text());
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
          author: { name: "Compass CRM", email: "crm@compassmarketing.ai" },
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
    if (pullRequest && branch !== "main") {
      const existing = await gh(`/repos/${owner}/${name}/pulls?head=${owner}:${branch}&base=main&state=open`);
      const open = existing.ok ? ((await existing.json()) as { html_url: string }[]) : [];
      if (open[0]) prUrl = open[0].html_url;
      else {
        const pr = await gh(`/repos/${owner}/${name}/pulls`, {
          method: "POST",
          body: JSON.stringify({
            title: pullRequest.title ?? message,
            body: pullRequest.body ?? "Opened by the Compass CRM worker.",
            head: branch,
            base: "main",
          }),
        });
        if (!pr.ok) throw fail("pull request", pr, await pr.text());
        prUrl = (await pr.json()).html_url;
      }
    }

    // ── Record it ───────────────────────────────────────────────────────
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
          // A pull-request push lives on a side branch; the site's branch
          // of record does not move until Tom merges it.
          ...(pullRequest ? {} : { branch }),
          last_pushed_at: new Date().toISOString(),
          last_commit_url: commitUrl,
        })
        .eq("id", site.id);
    } else {
      await supabase.from("sites").insert({
        client_id: client.id,
        url: client.website_url,
        stack: "astro",
        controlled_by_compass: true,
        repo_url: repoUrl,
        branch,
        last_pushed_at: new Date().toISOString(),
        last_commit_url: commitUrl,
      });
    }

    const vercel = await vercelStep();
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
      files: files.length,
      deleted: baseTree ? deletes.length : 0,
      created_repo: createdRepo,
      pull_request_url: prUrl,
      vercel,
      note:
        branch === "compass-astro"
          ? "main already carries a site that is not ours; the build is on compass-astro for Tom to blend."
          : undefined,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
});
