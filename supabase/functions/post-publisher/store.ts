// The post publisher's database side, over a supabase-js client created
// with the service role key. Every write goes through PostgREST, so 0045's
// triggers see the publisher (session_user authenticator, role
// service_role) and enforce the workflow: a claim re-checks the approval
// fingerprint and grounding, and only the publisher may record a result.

// deno-lint-ignore no-explicit-any
type Client = any;

export type PostRow = {
  id: string;
  client_id: string;
  platform: string;
  copy: string | null;
  review_status: string;
  publish_status: string;
  scheduled_at: string | null;
  publish_attempts: number;
  last_attempt_at: string | null;
  approved_snapshot: Record<string, unknown> | null;
  external_post_id: string | null;
};

export type RunRow = {
  post_id: string;
  client_id: string;
  mode: "tick" | "now" | "sweep" | "retry" | "reminder";
  outcome: "published" | "reconciled" | "failed" | "blocked" | "lapsed" | "retry_scheduled" | "reminder_opened" | "reminder_closed";
  transient?: boolean;
  http_status?: number | null;
  detail?: string | null;
  task_id?: string | null;
};

const POST_COLS =
  "id, client_id, platform, copy, review_status, publish_status, scheduled_at, publish_attempts, last_attempt_at, approved_snapshot, external_post_id";

export function createStore(supabase: Client) {
  const one = async <T>(q: Promise<{ data: T | null; error: { message: string } | null }>): Promise<T | null> => {
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    async secret(name: string): Promise<string | null> {
      const { data } = await supabase.rpc("get_secret", { secret_name: name });
      return (data as string | null) || null;
    },

    async teamMemberForJwt(jwt: string): Promise<string | null> {
      if (!jwt) return null;
      const { data } = await supabase.auth.getUser(jwt);
      if (!data?.user) return null;
      const { data: m } = await supabase.from("team_members").select("id").eq("auth_user_id", data.user.id).maybeSingle();
      return m?.id ?? null;
    },

    async settings(): Promise<{ enabled: boolean; clients: string[] }> {
      const row = await one<{ value: { enabled?: boolean; clients?: string[] } }>(
        supabase.from("app_settings").select("value").eq("key", "publisher").maybeSingle()
      );
      return { enabled: row?.value?.enabled === true, clients: Array.isArray(row?.value?.clients) ? row!.value.clients! : [] };
    },

    async post(id: string): Promise<PostRow | null> {
      return one(supabase.from("social_posts").select(POST_COLS).eq("id", id).maybeSingle());
    },

    async dueGbpPosts(nowIso: string, limit: number): Promise<PostRow[]> {
      return (await one<PostRow[]>(
        supabase.from("social_posts").select(POST_COLS)
          .eq("platform", "google_business").eq("publish_status", "scheduled").eq("review_status", "approved")
          .lte("scheduled_at", nowIso).order("scheduled_at", { ascending: true }).limit(limit)
      )) ?? [];
    },

    async stuckGbpPosts(beforeIso: string): Promise<PostRow[]> {
      return (await one<PostRow[]>(
        supabase.from("social_posts").select(POST_COLS)
          .eq("platform", "google_business").eq("publish_status", "publishing").lte("last_attempt_at", beforeIso)
      )) ?? [];
    },

    async failedGbpPosts(): Promise<PostRow[]> {
      return (await one<PostRow[]>(
        supabase.from("social_posts").select(POST_COLS)
          .eq("platform", "google_business").eq("publish_status", "failed").eq("review_status", "approved")
      )) ?? [];
    },

    async dueHandPosts(nowIso: string): Promise<PostRow[]> {
      return (await one<PostRow[]>(
        supabase.from("social_posts").select(POST_COLS)
          .neq("platform", "google_business").eq("publish_status", "scheduled").eq("review_status", "approved")
          .lte("scheduled_at", nowIso)
      )) ?? [];
    },

    async openReminders(): Promise<{ post_id: string; client_id: string; task_id: string | null }[]> {
      return (await one<{ post_id: string; client_id: string; task_id: string | null }[]>(
        supabase.from("publisher_runs").select("post_id, client_id, task_id").eq("outcome", "reminder_opened")
      )) ?? [];
    },

    async hasReminder(postId: string): Promise<boolean> {
      const rows = await one<{ id: number }[]>(
        supabase.from("publisher_runs").select("id").eq("post_id", postId).eq("outcome", "reminder_opened").limit(1)
      );
      return (rows ?? []).length > 0;
    },

    async hasClosedReminder(postId: string): Promise<boolean> {
      const rows = await one<{ id: number }[]>(
        supabase.from("publisher_runs").select("id").eq("post_id", postId).eq("outcome", "reminder_closed").limit(1)
      );
      return (rows ?? []).length > 0;
    },

    async latestRun(postId: string): Promise<{ outcome: string; transient: boolean; detail: string | null } | null> {
      return one(
        supabase.from("publisher_runs").select("outcome, transient, detail").eq("post_id", postId)
          .order("id", { ascending: false }).limit(1).maybeSingle()
      );
    },

    async client(id: string) {
      return one<{ id: string; name: string; dba: string | null; phone: string | null; gbp_location: string | null }>(
        supabase.from("clients").select("id, name, dba, phone, gbp_location").eq("id", id).maybeSingle()
      );
    },

    async setGbpLocation(clientId: string, value: string): Promise<void> {
      const { error } = await supabase.from("clients").update({ gbp_location: value }).eq("id", clientId);
      if (error) throw new Error(error.message);
    },

    // scheduled → publishing. The 0045 trigger refuses it when the approval
    // fingerprint or grounding no longer holds; the error comes back here.
    async claim(id: string): Promise<{ ok: true; row: PostRow } | { ok: false; error: string | null }> {
      const { data, error } = await supabase.from("social_posts")
        .update({ publish_status: "publishing" }).eq("id", id).eq("publish_status", "scheduled")
        .select(POST_COLS);
      if (error) return { ok: false, error: error.message };
      if (!data?.length) return { ok: false, error: null }; // taken by another run, or moved
      return { ok: true, row: data[0] };
    },

    async markPublished(id: string, v: { external_post_id: string; published_url: string; published_at: string }): Promise<void> {
      const { error } = await supabase.from("social_posts")
        .update({ publish_status: "published", ...v }).eq("id", id).eq("publish_status", "publishing");
      if (error) throw new Error(error.message);
    },

    async markFailed(id: string, message: string): Promise<void> {
      const { error } = await supabase.from("social_posts")
        .update({ publish_status: "failed", error: message.slice(0, 1000) }).eq("id", id).eq("publish_status", "publishing");
      if (error) throw new Error(error.message);
    },

    async retry(id: string): Promise<boolean> {
      const { data, error } = await supabase.from("social_posts")
        .update({ publish_status: "scheduled" }).eq("id", id).eq("publish_status", "failed").select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async unschedule(id: string): Promise<void> {
      const { error } = await supabase.from("social_posts")
        .update({ publish_status: "not_scheduled" }).eq("id", id).eq("publish_status", "scheduled");
      if (error) throw new Error(error.message);
    },

    async recheck(id: string): Promise<void> {
      await supabase.rpc("recheck_social_posts", { p_post_ids: [id] });
    },

    async insertRun(run: RunRow): Promise<void> {
      const { error } = await supabase.from("publisher_runs").insert(run);
      if (error) throw new Error(error.message);
    },

    // One open task per (client, key[, post]). Returns the task id.
    async openTask(t: { client_id: string; key: string; title: string; notes: string; post_id?: string }): Promise<string> {
      let q = supabase.from("tasks").select("id").eq("client_id", t.client_id).eq("key", t.key).neq("status", "done");
      if (t.post_id) q = q.ilike("notes", `%post_id=${t.post_id}%`);
      const existing = await one<{ id: string }[]>(q.limit(1));
      if (existing?.length) return existing[0].id;
      const created = await one<{ id: string }>(
        supabase.from("tasks").insert({
          client_id: t.client_id, key: t.key, owner: "TOM", status: "open",
          title: t.title.slice(0, 120), notes: t.notes,
        }).select("id").single()
      );
      return created!.id;
    },

    async closeTask(id: string, outcome: string): Promise<void> {
      const task = await one<{ status: string; notes: string | null }>(supabase.from("tasks").select("status, notes").eq("id", id).maybeSingle());
      if (!task || task.status === "done") return;
      const { error } = await supabase.from("tasks")
        .update({ status: "done", completed_at: new Date().toISOString(), notes: [task.notes, outcome].filter(Boolean).join("\n") })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },

    async signPhoto(path: string, seconds: number): Promise<string | null> {
      const { data } = await supabase.storage.from("brand-assets").createSignedUrl(path, seconds);
      return data?.signedUrl ?? null;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
