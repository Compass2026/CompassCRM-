// Client provisioning — the two hand-typed steps of Foundation stage 1
// (reconciliation.md build-order step 4): the Drive folder structure and the
// site's GitHub repo.
//
// Idempotent by lookup, not by bookkeeping: it searches Drive for a folder of
// the right name under the right parent and asks GitHub whether the repo
// exists before creating either, so re-running is a no-op and a half-finished
// run finishes itself.
//
// Auth: the same pair the other functions accept — a signed-in team member's
// JWT, or the x-cron-secret header (the clients_provision trigger uses the
// latter via pg_net).
//
// Vault secrets, all optional. A step whose secrets are missing reports
// "skipped" and the rest of the run continues, so this is safe to deploy
// before the credentials exist:
//   GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET  (fall back to GSC_CLIENT_ID /
//     GSC_CLIENT_SECRET when one Google app carries both scopes)
//   GDRIVE_REFRESH_TOKEN   — must carry https://www.googleapis.com/auth/drive.
//     The GSC refresh token is scoped to webmasters only and will not work.
//   GDRIVE_ROOT_FOLDER_ID  — the "Compass Clients" folder every client sits under
//   GITHUB_TOKEN           — PAT with repo scope (org: contents + administration)
//   GITHUB_ORG             — defaults to Compass2026
//
// Body: { client_id } (required).

import { createClient } from "npm:@supabase/supabase-js@2";

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const CHILD_FOLDERS = [
  "01 Onboarding",
  "02 Brand",
  "03 Keywords",
  "04 Website",
  "05 Reports",
  "Media",
];

type StepResult = {
  status: "created" | "existing" | "partial" | "skipped" | "failed";
  detail: string;
  [k: string]: unknown;
};

// Drive's query language is single-quoted; escape any quote in the name.
function q(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function repoSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 90);
}

async function googleAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).access_token as string;
}

async function findFolder(
  auth: HeadersInit,
  name: string,
  parentId: string
): Promise<string | null> {
  const params = new URLSearchParams({
    q: `name = '${q(name)}' and '${q(parentId)}' in parents and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`,
    fields: "files(id,name)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    pageSize: "1",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: auth,
  });
  if (!res.ok) {
    throw new Error(`Drive search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).files?.[0]?.id ?? null;
}

async function createFolder(
  auth: HeadersInit,
  name: string,
  parentId: string
): Promise<string> {
  const res = await fetch(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id",
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: DRIVE_FOLDER_MIME,
        parents: [parentId],
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Drive create failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).id as string;
}

async function ensureFolder(
  auth: HeadersInit,
  name: string,
  parentId: string
): Promise<{ id: string; created: boolean }> {
  const found = await findFolder(auth, name, parentId);
  if (found) return { id: found, created: false };
  return { id: await createFolder(auth, name, parentId), created: true };
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
    // Signed in is not enough once clients have portal logins: team only.
    const { data: member } = await supabase
      .from("team_members")
      .select("id")
      .eq("auth_user_id", userData.user.id)
      .maybeSingle();
    if (!member) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const body = await req.json().catch(() => ({}));
  const clientId: string | null = body.client_id ?? null;
  if (!clientId) {
    return Response.json({ error: "client_id is required" }, { status: 400 });
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, name, drive_folders, drive_root_url, website_url")
    .eq("id", clientId)
    .single();
  if (clientError || !client) {
    return Response.json({ error: clientError?.message ?? "client not found" }, { status: 404 });
  }

  const drive: StepResult = { status: "skipped", detail: "" };
  const github: StepResult = { status: "skipped", detail: "" };

  // ── Drive: <root> / <Client name> / {01 Onboarding … Media} ─────────────
  const [gClientId, gClientSecret, gRefresh, gRoot] = await Promise.all([
    secret("GDRIVE_CLIENT_ID").then(async (v) => v ?? (await secret("GSC_CLIENT_ID"))),
    secret("GDRIVE_CLIENT_SECRET").then(async (v) => v ?? (await secret("GSC_CLIENT_SECRET"))),
    secret("GDRIVE_REFRESH_TOKEN"),
    secret("GDRIVE_ROOT_FOLDER_ID"),
  ]);

  if (!gClientId || !gClientSecret || !gRefresh || !gRoot) {
    drive.detail =
      "Drive not configured — set GDRIVE_REFRESH_TOKEN (drive scope) and GDRIVE_ROOT_FOLDER_ID in Vault, plus GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET if the Google app differs from the GSC one.";
  } else {
    try {
      const token = await googleAccessToken(gClientId, gClientSecret, gRefresh);
      const auth = { Authorization: `Bearer ${token}` };

      const root = await ensureFolder(auth, client.name, gRoot);
      const folders: Record<string, string> = { root: root.id };
      let created = root.created ? 1 : 0;
      for (const name of CHILD_FOLDERS) {
        const child = await ensureFolder(auth, name, root.id);
        folders[name] = child.id;
        if (child.created) created += 1;
      }

      // Merge, so a folder recorded by hand is never dropped.
      const existing =
        client.drive_folders && typeof client.drive_folders === "object" &&
        !Array.isArray(client.drive_folders)
          ? (client.drive_folders as Record<string, unknown>)
          : {};
      const { error: updateError } = await supabase
        .from("clients")
        .update({
          drive_folders: { ...existing, ...folders },
          drive_root_url:
            client.drive_root_url ??
            `https://drive.google.com/drive/folders/${root.id}`,
        })
        .eq("id", clientId);
      if (updateError) throw new Error(updateError.message);

      drive.status = created === 0 ? "existing" : created === 7 ? "created" : "partial";
      drive.detail =
        created === 0
          ? "All seven folders already existed."
          : `Created ${created} of 7 folders; the rest already existed.`;
      drive.folders = folders;
    } catch (e) {
      drive.status = "failed";
      drive.detail = e instanceof Error ? e.message : String(e);
    }
  }

  // ── GitHub: the site repo ───────────────────────────────────────────────
  const [ghToken, ghOrgSecret] = await Promise.all([
    secret("GITHUB_TOKEN"),
    secret("GITHUB_ORG"),
  ]);
  const ghOrg = ghOrgSecret ?? "Compass2026";
  const slug = repoSlug(client.name);

  if (!ghToken) {
    github.detail = "GitHub not configured — set GITHUB_TOKEN in Vault (PAT with repo scope).";
  } else if (!slug) {
    github.status = "failed";
    github.detail = `Cannot derive a repo name from "${client.name}".`;
  } else {
    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "compass-client-platform",
    };
    try {
      let repoUrl: string | null = null;
      const head = await fetch(`https://api.github.com/repos/${ghOrg}/${slug}`, {
        headers: ghHeaders,
      });
      if (head.ok) {
        repoUrl = (await head.json()).html_url as string;
        github.status = "existing";
        github.detail = `${ghOrg}/${slug} already exists.`;
      } else if (head.status === 404) {
        // Compass2026 is a user account: repos under it are created with
        // /user/repos. Only a real organization takes /orgs/{org}/repos.
        const me = await fetch("https://api.github.com/user", { headers: ghHeaders });
        if (!me.ok) throw new Error(`GitHub whoami failed (${me.status})`);
        const login: string = (await me.json()).login;
        const isSelf = login.toLowerCase() === ghOrg.toLowerCase();
        const create = await fetch(
          isSelf ? "https://api.github.com/user/repos" : `https://api.github.com/orgs/${ghOrg}/repos`,
          {
            method: "POST",
            headers: { ...ghHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              name: slug,
              private: true,
              auto_init: true,
              description: `${client.name} — Compass Marketing Advisors`,
            }),
          }
        );
        if (!create.ok) {
          throw new Error(
            `Repo create failed (${create.status}): ${(await create.text()).slice(0, 200)}`
          );
        }
        repoUrl = (await create.json()).html_url as string;
        github.status = "created";
        github.detail = `Created ${ghOrg}/${slug}.`;
      } else {
        throw new Error(
          `Repo lookup failed (${head.status}): ${(await head.text()).slice(0, 200)}`
        );
      }

      // Record it on the client's site row, creating one if this is the first.
      const { data: site } = await supabase
        .from("sites")
        .select("id, repo_url")
        .eq("client_id", clientId)
        .limit(1)
        .maybeSingle();
      if (site) {
        if (!site.repo_url) {
          await supabase.from("sites").update({ repo_url: repoUrl }).eq("id", site.id);
        }
      } else {
        await supabase.from("sites").insert({
          client_id: clientId,
          url: client.website_url,
          stack: "astro",
          controlled_by_compass: true,
          repo_url: repoUrl,
        });
      }
      github.repo_url = repoUrl;
    } catch (e) {
      github.status = "failed";
      github.detail = e instanceof Error ? e.message : String(e);
    }
  }

  // ── Close the checklist tasks the run actually satisfied ────────────────
  const done: string[] = [];
  const closeTask = async (key: string) => {
    const { data } = await supabase
      .from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("key", key)
      .neq("status", "done")
      .select("id");
    if (data?.length) done.push(key);
  };
  if (drive.status === "created" || drive.status === "existing") {
    await closeTask("drive_folders");
  }
  if (github.status === "created" || github.status === "existing") {
    await closeTask("github_repo");
  }

  const failed = drive.status === "failed" || github.status === "failed";
  return Response.json(
    { client: client.name, drive, github, tasks_closed: done },
    { status: failed ? 502 : 200 }
  );
});
