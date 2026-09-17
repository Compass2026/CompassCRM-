// portal-invite — invites a client contact to the portal.
//
// Creating an auth user needs the service role, which the app never holds, so
// the Settings / Overview button calls this function with the team member's
// JWT and it does the two writes: Supabase Auth invite (a magic link that
// lands on /auth/confirm?next=/portal) and the portal_users row.
//
// Auth: a team JWT only. There is no cron path — nobody should be inviting
// clients on a schedule.
//
// Body:
//   { client_id, email, name?, redirect_to }   invite (or re-invite) a contact
//   { email, revoke: true }                    deactivate a portal user
//
// The portal_users triggers refuse a team address and link auth_user_id by
// email, so an invite for someone who already has a sign-in still works.

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  const { data: userData } = await supabase.auth.getUser(jwt);
  if (!userData?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: member } = await supabase
    .from("team_members")
    .select("id, email")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();
  if (!member) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const email: string = String(body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return Response.json({ error: "a valid email is required" }, { status: 400 });
  }

  // ── Revoke ──────────────────────────────────────────────────────────────
  if (body.revoke === true) {
    const { error } = await supabase
      .from("portal_users")
      .update({ is_active: false })
      .eq("email", email);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true, email, status: "revoked" });
  }

  // ── Invite ──────────────────────────────────────────────────────────────
  const clientId: string | null = body.client_id ?? null;
  if (!clientId) {
    return Response.json({ error: "client_id is required" }, { status: 400 });
  }
  let redirectTo: string;
  try {
    const url = new URL(String(body.redirect_to));
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error();
    redirectTo = url.toString();
  } catch {
    return Response.json({ error: "redirect_to must be an https URL" }, { status: 400 });
  }

  const { data: client } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", clientId)
    .maybeSingle();
  if (!client) {
    return Response.json({ error: "client not found" }, { status: 404 });
  }

  // The row first: its trigger refuses a team address, so a bad invite never
  // creates an auth user.
  const { error: rowError } = await supabase
    .from("portal_users")
    .upsert(
      {
        client_id: clientId,
        email,
        name: body.name ?? null,
        is_active: true,
        invited_at: new Date().toISOString(),
        invited_by: member.email,
      },
      { onConflict: "email" }
    );
  if (rowError) {
    return Response.json({ error: rowError.message }, { status: 400 });
  }

  // Already has a sign-in (re-invite, or a second client contact who was
  // invited before): send a magic link instead of a fresh invite.
  const { data: existing } = await supabase.auth.admin.listUsers();
  const already = existing?.users?.find(
    (u) => (u.email ?? "").toLowerCase() === email
  );

  const { error: mailError } = already
    ? await supabase.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: { redirectTo },
      }).then((r) => ({ error: r.error }))
    : await supabase.auth.admin.inviteUserByEmail(email, { redirectTo });

  if (mailError) {
    return Response.json(
      {
        error: `invite row saved, but the email failed: ${mailError.message}`,
        hint: "Supabase's built-in mailer allows a couple of messages an hour; custom SMTP (Resend) removes that limit.",
      },
      { status: 502 }
    );
  }

  // Link auth_user_id straight away when the account already existed.
  if (already) {
    await supabase
      .from("portal_users")
      .update({ auth_user_id: already.id })
      .eq("email", email);
  }

  return Response.json({
    ok: true,
    email,
    client: client.name,
    status: already ? "link_sent" : "invited",
  });
});
