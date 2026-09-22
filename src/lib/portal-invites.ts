// Client portal invites are behind a server-side flag (Sept 22 2026).
//
// Merging to `main` deploys the CRM to production through Vercel. The portal's
// read-only routes and its existing data are safe to ship, but sending
// invitations is not yet: 0042 is unapplied, the rewritten `portal-invite`
// Edge Function is undeployed, and custom SMTP is not set. So the invite form
// stays off in every deployment until PORTAL_INVITES_ENABLED is set to "true"
// in that deployment's environment (docs/portal-reconciliation.md, "To go
// live").
//
// Server-only on purpose: not NEXT_PUBLIC_, so it is never inlined into the
// browser bundle and the check cannot be flipped client-side. Anything other
// than the exact string "true" (unset, "", "1", "yes", "TRUE ") means off.
//
// No Next.js imports here, so tests/portal-invites.test.mjs can run it.

export const PORTAL_INVITES_FLAG = "PORTAL_INVITES_ENABLED";

export const PORTAL_INVITES_OFF_MESSAGE =
  "Client portal invites are switched off in this deployment. No invitation was sent.";

type Env = Record<string, string | undefined>;

export function portalInvitesEnabled(env: Env = process.env): boolean {
  return env[PORTAL_INVITES_FLAG] === "true";
}

export type InviteDeps = {
  env: Env;
  // Calls the portal-invite Edge Function (sends the email).
  send: (body: Record<string, unknown>) => Promise<void>;
  origin: () => Promise<string>;
};

// The invite server action's body. The flag is checked before anything
// else, so a direct POST of the form (bypassing the hidden UI) is refused
// without reading the form, calling the Edge Function or sending mail.
export async function runPortalInvite(
  deps: InviteDeps,
  clientId: string,
  formData: FormData
): Promise<void> {
  if (!portalInvitesEnabled(deps.env)) throw new Error(PORTAL_INVITES_OFF_MESSAGE);

  const email = String(formData.get("email") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!email) throw new Error("Email is required");

  await deps.send({
    client_id: clientId,
    email,
    name: name || null,
    redirect_to: `${await deps.origin()}/auth/confirm?next=/portal`,
  });
}
