"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { runPortalInvite } from "@/lib/portal-invites";

// The portal lives on the same app, so the invite link points back at this
// deployment — preview or production, whichever the invite was sent from.
async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function callPortalInvite(body: Record<string, unknown>) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/portal-invite`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const json = JSON.parse(text);
      message = [json.error, json.hint].filter(Boolean).join(" — ");
    } catch {
      // keep the raw body
    }
    throw new Error(message);
  }
}

// Refused unless PORTAL_INVITES_ENABLED is "true" in this deployment
// (src/lib/portal-invites.ts) — the form is hidden when it is off, and this
// check covers a direct submission.
export async function invitePortalUserAction(
  clientId: string,
  formData: FormData
) {
  await runPortalInvite(
    { env: process.env, send: callPortalInvite, origin: siteOrigin },
    clientId,
    formData
  );
  revalidatePath(`/clients/${clientId}`);
}

// Revoke is not behind the flag: taking access away must always work.

export async function revokePortalUserAction(clientId: string, email: string) {
  // Scoped to this client, so a revoke from one client's page can never touch
  // another client's contact.
  await callPortalInvite({ email, revoke: true, client_id: clientId });
  revalidatePath(`/clients/${clientId}`);
}
