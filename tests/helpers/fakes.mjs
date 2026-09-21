// Fakes for the site-push request-boundary tests: a Supabase client that
// answers the query chains the handler uses from an in-memory store, and a
// GitHub API served from an in-memory repository model. Every call is
// recorded so a test can assert what was (and was not) written.

export function fakeSupabase({ tables = {}, secrets = {}, teamJwt = "team-jwt" } = {}) {
  const store = structuredClone({ team_members: [{ id: "tm-1", auth_user_id: "team" }], ...tables });
  const writes = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = "select"; this.payload = null; this.take = null; }
    select() { return this; }
    order() { return this; }
    limit(n) { this.take = n; return this; }
    eq(k, v) { this.filters.push([k, v]); return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    delete() { this.op = "delete"; return this; }
    rows() { return (store[this.table] ?? []).filter((r) => this.filters.every(([k, v]) => r[k] === v)); }
    run() {
      if (this.op === "update") { const rows = this.rows(); for (const r of rows) Object.assign(r, this.payload); writes.push({ table: this.table, op: "update", filters: this.filters, patch: this.payload, matched: rows.length }); return { data: rows, error: null }; }
      if (this.op === "insert") { const row = { id: `${this.table}-${(store[this.table] ?? []).length + 1}`, ...this.payload }; (store[this.table] ??= []).push(row); writes.push({ table: this.table, op: "insert", row }); return { data: [row], error: null }; }
      if (this.op === "delete") { const rows = this.rows(); store[this.table] = (store[this.table] ?? []).filter((r) => !rows.includes(r)); writes.push({ table: this.table, op: "delete", filters: this.filters }); return { data: rows, error: null }; }
      return { data: this.rows(), error: null };
    }
    single() { const r = this.run(); return Promise.resolve(r.data?.[0] ? { data: r.data[0], error: null } : { data: null, error: { message: "not found" } }); }
    maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); }
    then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject(e); } }
  }
  return {
    store,
    writes,
    from: (table) => new Query(table),
    rpc: async (fn, args) => (fn === "get_secret" ? { data: secrets[args.secret_name] ?? null } : { data: null }),
    auth: { getUser: async (jwt) => ({ data: { user: jwt === teamJwt ? { id: "team" } : jwt === "client-jwt" ? { id: "client" } : null } }) },
  };
}

/**
 * repos: { "Owner/name": { id, default_branch, empty, files: { "vercel.json": "…" },
 *                          branches: { main: { author: "Tom" | "Compass CRM" } } } }
 *
 * `files` is the repository content a GET of the Contents API serves — used
 * by the vercel.json enforcement, which reads the current file before it
 * commits. A path absent from `files` answers 404, as GitHub does.
 */
export function fakeGitHub({ repos = {}, login = "Compass2026", vercel = null } = {}) {
  const calls = [];
  let n = 0;
  const id = (p) => `${p}${++n}`;
  const model = {};
  for (const [full, r] of Object.entries(repos)) {
    const refs = {}; const commits = {};
    for (const [b, info] of Object.entries(r.branches ?? {})) {
      const tree = id("tree-"); const sha = id("head-");
      commits[sha] = { sha, tree, author: { name: info.author ?? "Compass CRM" }, parents: [], message: `head of ${b}` };
      refs[b] = sha;
    }
    model[full] = { id: r.id ?? 1000 + n, html_url: `https://github.com/${full}`, default_branch: r.default_branch ?? "main", empty: !!r.empty, refs, commits, pulls: [], files: { ...(r.files ?? {}) } };
  }
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  // site-push deploys by { repoId, ref }; Vercel resolves that to the head
  // commit, and that is the SHA its deployment record carries.
  const resolveGitSha = (src) => {
    if (!src) return null;
    if (src.sha) return src.sha;
    const repo = Object.values(model).find((r) => r.id === src.repoId);
    return repo?.refs?.[src.ref] ?? null;
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname + u.search, body });
    if (u.host === "api.vercel.com") {
      // Opt-in Vercel model. Its one interesting behaviour, verified against
      // the real API on Sept 20 2026: a project's FIRST deployment is
      // promoted to production whatever the branch, and later ones with no
      // `target` come back as previews (target null).
      if (!vercel) return json(500, { error: "vercel not faked" });
      vercel.projects ??= {}; vercel.deployments ??= {};
      let vm;
      if ((vm = u.pathname.match(/^\/v9\/projects\/([^/]+)$/)) && method === "GET") {
        const p = vercel.projects[vm[1]];
        return p ? json(200, { id: p.id ?? `prj_${vm[1]}`, name: vm[1] }) : json(404, { message: "not found" });
      }
      if (u.pathname === "/v10/projects" && method === "POST") {
        vercel.projects[body.name] = { id: `prj_${body.name}`, deployments: 0 };
        return json(201, { id: `prj_${body.name}`, name: body.name });
      }
      // The deployment listing site-push checks BEFORE deploying a preview.
      if (u.pathname === "/v6/deployments" && method === "GET") {
        // The duplicate sweep site-push runs after its own deployment:
        // every record Vercel holds for one commit SHA. `duplicateSha`
        // models a repo that slipped through without vercel.json, so the
        // Git integration deployed the commit as well.
        const sha = u.searchParams.get("sha");
        if (sha) {
          const ours = Object.values(vercel.deployments ?? {}).filter((d) => d.sha === sha);
          const extra = vercel.duplicateSha ? [{ id: "dpl_git_integration", source: "git", target: null }] : [];
          return json(200, { deployments: [...ours.map((d) => ({ id: d.id, source: "rest-api", target: d.target ?? null })), ...extra] });
        }
        const wanted = u.searchParams.get("projectId");
        const entry = Object.entries(vercel.projects).find(([nm, p]) => p.id === wanted || nm === wanted);
        // `listingSays` lets a test simulate a listing that disagrees with
        // reality, to exercise the check behind the pre-flight one.
        // `blockedOnly` models Vercel's Git integration registering a
        // deployment for our push and then blocking it: it exists, but it is
        // not READY, so a state=READY query must not see it.
        const wantsReady = (u.searchParams.get("state") ?? "").includes("READY");
        const p = entry ? entry[1] : null;
        const ready = p ? (p.listingSays ?? (p.blockedOnly ? 0 : p.deployments)) : 0;
        const any = p ? (p.listingSays ?? p.deployments + (p.blockedOnly ? 1 : 0)) : 0;
        const made = wantsReady ? ready : any;
        return json(200, { deployments: made > 0 ? [{ id: "dpl_existing" }] : [] });
      }
      if (u.pathname === "/v13/deployments" && method === "POST") {
        const proj = (vercel.projects[body.project] ??= { id: `prj_${body.project}`, deployments: 0 });
        const first = proj.deployments === 0;
        proj.deployments += 1;
        const id = `dpl_${++n}`;
        const dep = { id, url: `${body.project}-${id}.vercel.app`, target: body.target ?? (first ? "production" : null), readyState: "READY", sha: resolveGitSha(body.gitSource) };
        vercel.deployments[id] = dep;
        return json(200, dep);
      }
      if ((vm = u.pathname.match(/^\/v13\/deployments\/([^/]+)$/)) && method === "GET") {
        const d = vercel.deployments[decodeURIComponent(vm[1])];
        return d ? json(200, d) : json(404, { message: "not found" });
      }
      return json(404, { message: `unhandled vercel ${method} ${u.pathname}` });
    }
    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (u.pathname === "/user" && method === "GET") return json(200, { login });
    if (u.pathname === "/user/repos" && method === "POST") {
      const full = `${login}/${body.name}`;
      model[full] = { id: 5000 + ++n, html_url: `https://github.com/${full}`, default_branch: "main", empty: true, refs: {}, commits: {}, pulls: [], files: {} };
      return json(201, { id: model[full].id, html_url: model[full].html_url, default_branch: "main" });
    }
    if (!m) return json(404, { message: "no route" });
    const full = `${m[1]}/${m[2]}`; const rest = m[3] ?? ""; const repo = model[full];
    if (!repo) return json(404, { message: "Not Found" });
    if (rest === "" && method === "GET") return json(200, { id: repo.id, html_url: repo.html_url, default_branch: repo.default_branch });
    let mm;
    if ((mm = rest.match(/^\/git\/ref\/heads\/(.+)$/)) && method === "GET") {
      if (repo.empty) return json(409, { message: "Git Repository is empty." });
      const sha = repo.refs[decodeURIComponent(mm[1])];
      return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
    }
    if ((mm = rest.match(/^\/git\/commits\/([^/]+)$/)) && method === "GET") { const c = repo.commits[mm[1]]; return c ? json(200, { sha: c.sha, tree: { sha: c.tree }, author: c.author, parents: c.parents.map((p) => ({ sha: p })), message: c.message }) : json(404, {}); }
    if (rest === "/git/refs" && method === "POST") { repo.refs[body.ref.replace(/^refs\/heads\//, "")] = body.sha; return json(201, { ref: body.ref, object: { sha: body.sha } }); }
    if ((mm = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "PATCH") { const b = decodeURIComponent(mm[1]); if (!(b in repo.refs)) return json(422, { message: "Reference does not exist" }); repo.refs[b] = body.sha; return json(200, { object: { sha: body.sha } }); }
    if (rest === "/git/blobs" && method === "POST") return json(201, { sha: id("blob-") });
    if (rest === "/git/trees" && method === "POST") return json(201, { sha: id("tree-") });
    if (rest === "/git/commits" && method === "POST") { const sha = id("commit-"); repo.commits[sha] = { sha, tree: body.tree, author: body.author, parents: body.parents ?? [], message: body.message }; return json(201, { sha }); }
    if ((mm = rest.match(/^\/contents\/([^?]+)/)) && method === "GET") {
      const want = decodeURIComponent(mm[1]);
      const body404 = { message: "Not Found" };
      if (!(want in repo.files)) return json(404, body404);
      const raw = repo.files[want];
      // `serveRaw` lets a test return a shape the handler must refuse (a
      // directory listing, say) or a non-200 it must fail closed on.
      if (raw && typeof raw === "object" && "status" in raw) return json(raw.status, raw.body ?? {});
      if (Array.isArray(raw)) return json(200, raw);
      return json(200, { type: "file", path: want, encoding: "base64", content: btoa(String(raw)) });
    }
    if ((mm = rest.match(/^\/contents\/(.+)$/)) && method === "PUT") { const sha = id("commit-"); const tree = id("tree-"); repo.commits[sha] = { sha, tree, author: body.author ?? body.committer, parents: [], message: body.message }; repo.refs[body.branch] = sha; repo.empty = false; repo.files[decodeURIComponent(mm[1])] = atob(String(body.content)); return json(201, { commit: { sha, tree: { sha: tree }, html_url: `${repo.html_url}/commit/${sha}` } }); }
    if ((mm = rest.match(/^\/git\/trees\/([^/?]+)/)) && method === "GET") return json(200, { sha: mm[1], tree: [] });
    if (rest.startsWith("/pulls") && method === "GET") return json(200, repo.pulls.filter((p) => u.searchParams.get("base") === p.base && u.searchParams.get("head")?.endsWith(`:${p.head}`)));
    if (rest === "/pulls" && method === "POST") { const pr = { number: repo.pulls.length + 1, html_url: `${repo.html_url}/pull/${repo.pulls.length + 1}`, base: body.base, head: body.head, title: body.title }; repo.pulls.push(pr); return json(201, pr); }
    if ((mm = rest.match(/^\/tarball\/(.+)$/)) && method === "GET") return new Response(new TextEncoder().encode(`TARBALL ${full}@${mm[1]}`), { status: 200, headers: { "content-type": "application/x-gzip" } });
    return json(404, { message: `unhandled ${method} ${u.pathname}` });
  };
  return { fetch, calls, model, writes: () => calls.filter((c) => c.method !== "GET") };
}
