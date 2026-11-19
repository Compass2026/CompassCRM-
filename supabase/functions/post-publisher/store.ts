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
  reviewed_at: string | null;
  external_post_id: string | null;
  social_account_id: string | null;
  publish_key: string | null;
};

export type RunRow = {
  post_id: string;
  client_id: string;
  mode: "tick" | "now" | "sweep" | "retry" | "reminder";
  outcome: "published" | "reconciled" | "uncertain" | "ambiguous" | "failed" | "blocked" | "lapsed" | "retry_scheduled" | "reminder_opened" | "reminder_closed" | "submitted";
  transient?: boolean;
  http_status?: number | null;
  detail?: string | null;
  task_id?: string | null;
  // Zernio Social Publisher v1: how it went out, and Zernio's side of it.
  transport?: "google" | "zernio" | "manual";
  provider_post_id?: string | null;
  provider_status?: string | null;
  target_account_id?: string | null;
  // Business Profile through Zernio: the location the request was pinned to.
  target_location_id?: string | null;
  request_key?: string | null;
  provider_media_url?: string | null;
};

// A Zernio run as the Facebook path reads it back.
export type ZernioRun = {
  id: number; outcome: string; transient: boolean; detail: string | null; created_at: string; http_status: number | null;
  provider_post_id: string | null; provider_status: string | null; request_key: string | null; provider_media_url: string | null;
  target_account_id: string | null; target_location_id: string | null;
};

const BINDING_COLS =
  "id, client_id, platform, external_account_id, display_name, publish_provider, publish_account_id, publish_page_id, publish_account_name, publish_enabled, publish_verified_at, publish_health";

const POST_COLS =
  "id, client_id, platform, copy, review_status, publish_status, scheduled_at, publish_attempts, last_attempt_at, approved_snapshot, reviewed_at, external_post_id, social_account_id, publish_key";

export function createStore(supabase: Client) {
  const one = async <T>(q: Promise<{ data: T | null; error: { message: string } | null }>): Promise<T | null> => {
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data;
  };

  const closeTask = async (id: string, outcome: string): Promise<void> => {
    const task = await one<{ status: string; notes: string | null }>(supabase.from("tasks").select("status, notes").eq("id", id).maybeSingle());
    if (!task || task.status === "done") return;
    const { error } = await supabase.from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString(), notes: [task.notes, outcome].filter(Boolean).join("\n") })
      .eq("id", id);
    if (error) throw new Error(error.message);
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

    // Reminders are cycles: a post's reminder is open when its latest
    // reminder event is reminder_opened (publisher_reminder_state, 0046).
    async openReminders(): Promise<{ post_id: string; client_id: string; task_id: string | null }[]> {
      const { data, error } = await supabase.rpc("publisher_reminder_state");
      if (error) throw new Error(error.message);
      return ((data ?? []) as { post_id: string; client_id: string; outcome: string; task_id: string | null }[])
        .filter((r) => r.outcome === "reminder_opened")
        .map(({ post_id, client_id, task_id }) => ({ post_id, client_id, task_id }));
    },

    async reminderOpen(postId: string): Promise<boolean> {
      const { data, error } = await supabase.rpc("publisher_reminder_state", { p_post_ids: [postId] });
      if (error) throw new Error(error.message);
      return ((data ?? []) as { outcome: string }[]).some((r) => r.outcome === "reminder_opened");
    },

    async latestRun(postId: string): Promise<{ outcome: string; transient: boolean; detail: string | null } | null> {
      return one(
        supabase.from("publisher_runs").select("outcome, transient, detail").eq("post_id", postId)
          .order("id", { ascending: false }).limit(1).maybeSingle()
      );
    },

    // When this post's earliest attempt that may have reached Google was
    // recorded (failed, uncertain or ambiguous), across approvals.
    async firstAttemptRunAt(postId: string): Promise<string | null> {
      const row = await one<{ created_at: string }>(
        supabase.from("publisher_runs").select("created_at").eq("post_id", postId)
          .in("outcome", ["failed", "uncertain", "ambiguous"]).order("id", { ascending: true }).limit(1).maybeSingle()
      );
      return row?.created_at ?? null;
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

    async markPublished(id: string, v: { external_post_id: string | null; published_url: string; published_at: string }): Promise<void> {
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

    closeTask,

    // Open publisher tasks with these keys (for the checks that resolve them).
    async openTasks(keys: string[]): Promise<{ id: string; client_id: string; key: string }[]> {
      return (await one<{ id: string; client_id: string; key: string }[]>(
        supabase.from("tasks").select("id, client_id, key").in("key", keys).neq("status", "done")
      )) ?? [];
    },

    // Closes the open tasks the publisher opened for something now verified
    // fixed: by key, and by client and / or post marker when given.
    async closeOpenTasks(f: { keys: string[]; client_id?: string; post_id?: string }, outcome: string): Promise<string[]> {
      let q = supabase.from("tasks").select("id").in("key", f.keys).neq("status", "done");
      if (f.client_id) q = q.eq("client_id", f.client_id);
      if (f.post_id) q = q.ilike("notes", `%post_id=${f.post_id}%`);
      const rows = (await one<{ id: string }[]>(q)) ?? [];
      for (const r of rows) await closeTask(r.id, outcome);
      return rows.map((r) => r.id);
    },

    // ── Facebook through Zernio ──
    async memberIsAdmin(memberId: string): Promise<boolean> {
      const m = await one<{ role: string | null }>(supabase.from("team_members").select("role").eq("id", memberId).maybeSingle());
      return m?.role === "admin";
    },

    async account(id: string): Promise<import("./facebook.ts").Binding | null> {
      return one(supabase.from("social_accounts").select(BINDING_COLS).eq("id", id).maybeSingle());
    },

    async facebookAccounts(): Promise<import("./facebook.ts").Binding[]> {
      return (await one<import("./facebook.ts").Binding[]>(
        supabase.from("social_accounts").select(BINDING_COLS).eq("platform", "facebook").order("client_id")
      )) ?? [];
    },

    async dueFacebookPosts(nowIso: string, limit: number): Promise<PostRow[]> {
      return (await one<PostRow[]>(
        supabase.from("social_posts").select(POST_COLS)
          .eq("platform", "facebook").eq("publish_status", "scheduled").eq("review_status", "approved")
          .lte("scheduled_at", nowIso).order("scheduled_at", { ascending: true }).limit(limit)
      )) ?? [];
    },

    async publishingFacebookPosts(): Promise<PostRow[]> {
      return (await one<PostRow[]>(
        supabase.from("social_posts").select(POST_COLS).eq("platform", "facebook").eq("publish_status", "publishing")
      )) ?? [];
    },

    async failedFacebookPosts(): Promise<PostRow[]> {
      return (await one<PostRow[]>(
        supabase.from("social_posts").select(POST_COLS)
          .eq("platform", "facebook").eq("publish_status", "failed").eq("review_status", "approved")
      )) ?? [];
    },

    // This post's Zernio runs, oldest first.
    async zernioRuns(postId: string): Promise<ZernioRun[]> {
      return (await one<ZernioRun[]>(
        supabase.from("publisher_runs")
          .select("id, outcome, transient, detail, created_at, http_status, provider_post_id, provider_status, request_key, provider_media_url, target_account_id, target_location_id")
          .eq("post_id", postId).eq("transport", "zernio").order("id", { ascending: true })
      )) ?? [];
    },

    // What the claim would re-check, read without claiming (preflight).
    async postGate(postId: string): Promise<{ review_status: string; publish_status: string; hash_ok: boolean; grounding_problems: string[] } | null> {
      const { data, error } = await supabase.rpc("publisher_post_gate", { p_post_id: postId });
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async brandAsset(id: string): Promise<{ id: string; client_id: string; storage_path: string | null; content_hash: string | null; mime_type: string | null } | null> {
      return one(supabase.from("brand_assets").select("id, client_id, storage_path, content_hash, mime_type").eq("id", id).maybeSingle());
    },

    async creativeAsset(id: string): Promise<{ id: string; client_id: string; storage_path: string | null; content_hash: string | null; mime_type: string | null } | null> {
      return one(supabase.from("creative_assets").select("id, client_id, storage_path, content_hash, mime_type").eq("id", id).maybeSingle());
    },

    async download(bucket: "brand-assets" | "creative-assets", path: string): Promise<{ bytes: Uint8Array; type: string } | null> {
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error || !data) return null;
      return { bytes: new Uint8Array(await data.arrayBuffer()), type: data.type ?? "" };
    },

    async bindAccount(v: { social_account_id: string; account_id: string; page_id: string; account_name: string | null; health: unknown }): Promise<Record<string, unknown>> {
      const { data, error } = await supabase.rpc("publisher_bind_account", {
        p_social_account_id: v.social_account_id, p_account_id: v.account_id, p_page_id: v.page_id,
        p_account_name: v.account_name, p_health: v.health,
      });
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },

    // ── Business Profile through Zernio ──
    // A bound Business Profile location of the client (any one: a client may
    // have several since 20261027190935). Only decides whether the client is
    // on Zernio; a post is always sent to its own approved location.
    async gbpLocationForClient(clientId: string): Promise<import("./facebook.ts").Binding | null> {
      const rows = (await one<import("./facebook.ts").Binding[]>(
        supabase.from("social_accounts").select(BINDING_COLS)
          .eq("client_id", clientId).eq("platform", "google_business").not("publish_provider", "is", null).limit(1)
      )) ?? [];
      return rows[0] ?? null;
    },

    // The client's explicit Business Profile transport (20261011050000): no
    // row = google. Binding a location selects zernio; unbinding keeps it.
    async gbpTransportForClient(clientId: string): Promise<"google" | "zernio"> {
      const row = await one<{ gbp_transport: string }>(
        supabase.from("publisher_client_transports").select("gbp_transport").eq("client_id", clientId).maybeSingle()
      );
      return row?.gbp_transport === "zernio" ? "zernio" : "google";
    },

    async publishingGbpPosts(): Promise<PostRow[]> {
      return (await one<PostRow[]>(
        supabase.from("social_posts").select(POST_COLS).eq("platform", "google_business").eq("publish_status", "publishing")
      )) ?? [];
    },

    // Every run of a post, oldest first (which transport tried what).
    async postRuns(postId: string): Promise<{ id: number; transport: string; outcome: string; created_at: string }[]> {
      return (await one<{ id: number; transport: string; outcome: string; created_at: string }[]>(
        supabase.from("publisher_runs").select("id, transport, outcome, created_at").eq("post_id", postId).order("id", { ascending: true })
      )) ?? [];
    },

    // The piloted clients and every client with a Business Profile location
    // row, for the read-only accounts report.
    async clientsForGbp(piloted: string[]): Promise<{ id: string; name: string; website_url: string | null; location: import("./facebook.ts").Binding | null; locations: import("./facebook.ts").Binding[] }[]> {
      const rows = (await one<import("./facebook.ts").Binding[]>(
        supabase.from("social_accounts").select(BINDING_COLS).eq("platform", "google_business")
      )) ?? [];
      const ids = [...new Set([...piloted, ...rows.map((r) => r.client_id)])];
      if (!ids.length) return [];
      const clients = (await one<{ id: string; name: string; website_url: string | null }[]>(
        supabase.from("clients").select("id, name, website_url").in("id", ids).order("name")
      )) ?? [];
      return clients.map((c) => {
        const locations = rows.filter((r) => r.client_id === c.id && r.publish_provider);
        return { ...c, location: locations[0] ?? null, locations };
      });
    },

    async bindGbpLocation(v: { client_id: string; account_id: string; location_id: string; location_name: string | null; account_name: string | null; health: unknown }): Promise<Record<string, unknown>> {
      const { data, error } = await supabase.rpc("publisher_bind_gbp_location", {
        p_client_id: v.client_id, p_account_id: v.account_id, p_location_id: v.location_id,
        p_location_name: v.location_name, p_account_name: v.account_name, p_health: v.health,
      });
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },

    async signPhoto(path: string, seconds: number): Promise<string | null> {
      const { data } = await supabase.storage.from("brand-assets").createSignedUrl(path, seconds);
      return data?.signedUrl ?? null;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
