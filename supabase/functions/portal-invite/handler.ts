// portal-invite — invites a client contact to the portal.
//
// Creating an auth user needs the service role, which the app never holds, so
// the Overview tab's Client portal card calls this function with the team
// member's JWT and it does the writes: the portal_users row, the Supabase
// Auth email, and the link between the two (portal_users.auth_user_id, which
// portal_client_id() reads — an unlinked row gives its contact nothing).
//
// Auth: a team JWT only. There is no cron path — nobody should be inviting
// clients on a schedule.
//
// Body:
//   { client_id, email, name?, redirect_to }   invite, or re-invite, a contact
//   { email, revoke: true, client_id? }        deactivate a contact
//
// What the invite sends depends on the address:
//   no sign-in yet                  inviteUserByEmail            → "invited"
//   invited, never signed in        inviteUserByEmail again      → "invite_resent"
//                                   (GoTrue re-sends to an unconfirmed user)
//   has signed in before            signInWithOtp, no new user   → "link_sent"
// Every one of those sends an email through Supabase Auth. Nothing reports
// success until the email was accepted AND auth_user_id is saved on this
// client's row and read back.
//
// Order, and why a retry always converges:
//   1. Refuse before writing anything: bad input, unknown client, an address
//      that already belongs to another client (a contact is never moved —
//      0042 also refuses it in the database), a sign-in already active for
//      another client.
//   2. Save the row (insert, or reactivate this client's row).
//   3. Existing sign-in: link first, then send. New address: send (which
//      creates the user), then link the id the invite returned.
//   A failure after step 2 leaves the row saved and says so; sending the same
//   request again finds the row, finds the user the first attempt created,
//   links it and sends again.
//
// This file is the handler; index.ts wires the real Supabase client.
// tests/portal-invite-handler.test.mjs drives it with a fake one.

// deno-lint-ignore no-explicit-any
export type SupabaseLike = any;

export interface PortalInviteDeps {
  supabase: SupabaseLike;
  /** Page size for the auth user lookup; injectable so tests cover paging. */
  userPageSize?: number;
}

type AuthUser = { id: string; email?: string | null; email_confirmed_at?: string | null; confirmed_at?: string | null };

const json = (body: unknown, status = 200) => Response.json(body, { status });

// Postgres errors that mean "the constraints refused it", as PostgREST
// reports them.
function constraintConflict(err: { code?: string; message?: string } | null): boolean {
  return !!err && (err.code === "23505" || err.code === "23514");
}

export function createPortalInviteHandler(deps: PortalInviteDeps) {
  const PAGE = deps.userPageSize ?? 1000;

  return async (req: Request): Promise<Response> => {
    const supabase = deps.supabase;

    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData } = await supabase.auth.getUser(jwt);
    if (!userData?.user) return json({ error: "unauthorized" }, 401);
    const { data: member } = await supabase
      .from("team_members")
      .select("id, email")
      .eq("auth_user_id", userData.user.id)
      .maybeSingle();
    if (!member) return json({ error: "forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const email: string = String(body?.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) return json({ error: "a valid email is required" }, 400);
    const clientId: string | null = body?.client_id ?? null;

    // ── Revoke ──────────────────────────────────────────────────────────────
    if (body?.revoke === true) {
      let q = supabase.from("portal_users").update({ is_active: false }).eq("email", email);
      // The Overview card passes its client, so a revoke can only ever touch
      // that client's contact.
      if (clientId) q = q.eq("client_id", clientId);
      const { data, error } = await q.select("id");
      if (error) return json({ error: error.message }, 500);
      if (!data?.length) return json({ error: "no portal contact with that email for this client" }, 404);
      return json({ ok: true, email, status: "revoked" });
    }

    // ── Invite: refuse before writing anything ──────────────────────────────
    if (!clientId) return json({ error: "client_id is required" }, 400);
    let redirectTo: string;
    try {
      const url = new URL(String(body.redirect_to));
      if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error();
      redirectTo = url.toString();
    } catch {
      return json({ error: "redirect_to must be an https URL" }, 400);
    }

    const { data: client } = await supabase.from("clients").select("id, name").eq("id", clientId).maybeSingle();
    if (!client) return json({ error: "client not found" }, 404);

    const { data: existingRow, error: rowLookupError } = await supabase
      .from("portal_users")
      .select("id, client_id, auth_user_id, is_active")
      .eq("email", email)
      .maybeSingle();
    if (rowLookupError) return json({ error: rowLookupError.message }, 500);
    if (existingRow && existingRow.client_id !== clientId) {
      return json({
        error: "That address is already a portal contact for another client. A contact belongs to one client: revoke it there and have a team member remove the row before inviting it here.",
        code: "other_client",
      }, 409);
    }

    // The sign-in, if the address has one. listUsers is paged; walk it.
    let authUser: AuthUser | null = null;
    for (let page = 1; ; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PAGE });
      if (error) return json({ error: `could not look up the sign-in: ${error.message}` }, 502);
      const users: AuthUser[] = data?.users ?? [];
      authUser = users.find((u) => (u.email ?? "").toLowerCase() === email) ?? null;
      if (authUser || users.length < PAGE) break;
    }

    if (authUser) {
      const { data: elsewhere, error } = await supabase
        .from("portal_users")
        .select("id, client_id")
        .eq("auth_user_id", authUser.id)
        .eq("is_active", true);
      if (error) return json({ error: error.message }, 500);
      if ((elsewhere ?? []).some((r: { client_id: string }) => r.client_id !== clientId)) {
        return json({
          error: "That sign-in is already an active portal contact for another client; one sign-in sees one client.",
          code: "active_elsewhere",
        }, 409);
      }
    }

    // ── Save the row ────────────────────────────────────────────────────────
    const name: string | null = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    const fields = {
      // A re-invite without a name keeps the one on file.
      ...(name || !existingRow ? { name } : {}),
      is_active: true,
      invited_at: new Date().toISOString(),
      invited_by: member.email,
    };
    const saved = existingRow
      ? await supabase.from("portal_users").update(fields).eq("id", existingRow.id).eq("client_id", clientId).select("id").maybeSingle()
      : await supabase.from("portal_users").insert({ client_id: clientId, email, ...fields }).select("id").single();
    if (saved.error || !saved.data?.id) {
      const err = saved.error;
      // The team-address trigger raises; 0042's indexes answer 23505.
      return json({ error: err?.message ?? "the portal row was not saved" }, constraintConflict(err) ? 409 : 400);
    }
    const rowId: string = saved.data.id;

    // Link auth_user_id on THIS row and read it back; anything else is failure.
    const link = async (userId: string): Promise<Response | null> => {
      const { data, error } = await supabase
        .from("portal_users")
        .update({ auth_user_id: userId })
        .eq("id", rowId)
        .eq("client_id", clientId)
        .select("id, auth_user_id");
      const linked = !error && data?.length === 1 && data[0].auth_user_id === userId;
      if (linked) return null;
      return json({
        error: `the portal row is saved but its sign-in could not be linked${error ? `: ${error.message}` : ""}`,
        saved: true,
        linked: false,
        retry: "send the same invite again",
      }, error && constraintConflict(error) ? 409 : 500);
    };

    const confirmed = !!(authUser?.email_confirmed_at ?? authUser?.confirmed_at);
    let status: "invited" | "invite_resent" | "link_sent";
    if (authUser) {
      const refused = await link(authUser.id);
      if (refused) return refused;
      const { error } = confirmed
        ? await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } })
        : await supabase.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (error) return mailFailed(error.message, true);
      status = confirmed ? "link_sent" : "invite_resent";
    } else {
      const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (error) return mailFailed(error.message, false);
      const newId: string | undefined = data?.user?.id;
      if (!newId) {
        return json({ error: "the invite was sent but Supabase returned no user id", saved: true, linked: false, retry: "send the same invite again" }, 500);
      }
      const refused = await link(newId);
      if (refused) return refused;
      status = "invited";
    }

    return json({ ok: true, email, client: client.name, status, linked: true });
  };
}

function mailFailed(message: string, linked: boolean): Response {
  return json({
    error: `the portal row is saved, but the email failed: ${message}`,
    hint: "Supabase's built-in mailer allows a couple of messages an hour; custom SMTP (Resend) removes that limit.",
    saved: true,
    linked,
    retry: "send the same invite again",
  }, 502);
}
