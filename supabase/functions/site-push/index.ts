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
  if (!body?.client_id || !Array.isArray(body.files) || !body.files.length) {
    return Response.json(
      { error: "client_id and a non-empty files[] are required" },
      { status: 400 }
    );
  }
  const files = body.files as FileIn[];
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
  const full: string = body.repo ?? `${org}/${repoSlug(client.name)}`;
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
    const head = await gh(`/repos/${owner}/${name}`);
    if (head.ok) {
      repoUrl = (await head.json()).html_url;
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
      repoUrl = (await create.json()).html_url;
      createdRepo = true;
    } else {
      throw fail("repo lookup", head, await head.text());
    }

    // ── Which branch, and its current head ──────────────────────────────
    // A repo whose main already carries someone else's work (Pensacola has
    // a hand-built Next.js site on main) is never overwritten: the build
    // goes to `compass-astro` instead, and the caller is told which.
    const requested: string | null = body.branch ?? null;
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
    if (headInfo) {
      parentSha = headInfo.sha;
      baseTree = headInfo.tree;
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
        last_pushed_at: new Date().toISOString(),
        last_commit_url: commitUrl,
      });
    }

    return Response.json({
      repo_url: repoUrl,
      branch,
      branch_url: branchUrl,
      commit_url: commitUrl,
      files: files.length,
      deleted: baseTree ? deletes.length : 0,
      created_repo: createdRepo,
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
