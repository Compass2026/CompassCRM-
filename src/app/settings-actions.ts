"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";

// Settings-page actions. All of them talk to the google-connect Edge
// Function with the signed-in team member's JWT; the function does the
// Google calls and the Vault writes, so no token ever passes through here.

export type ActionState = { ok: boolean; message: string } | null;

export type Ga4Account = { id: string; name: string; properties: number };
export type Ga4AccountsState = { ok: boolean; message?: string; accounts?: Ga4Account[] } | null;

export type AccessRow = {
  id: string;
  name: string;
  gbp: "yes" | "no" | "unknown";
  gbp_title: string | null;
  gsc: "yes" | "no" | "unknown" | "n/a";
  ga4: "yes" | "no";
};
export type AccessCheck = {
  checked_at: string;
  gbp_error: string | null;
  gsc_error: string | null;
  locations: number;
  clients: AccessRow[];
};

async function callConnect(body: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown> | null }> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { status: 401, payload: { error: "Not signed in." } };
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/google-connect`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, payload };
  } catch (e) {
    return { status: 0, payload: { error: e instanceof Error ? e.message : "Could not reach google-connect." } };
  }
}

function errorOf(status: number, payload: Record<string, unknown> | null): string {
  if (payload && typeof payload.error === "string") return payload.error;
  return status === 0 ? "Could not reach google-connect." : `google-connect answered ${status}.`;
}

// Connect Google: asks the function for the consent URL and sends the browser
// there. Google redirects back to the function, which stores the token and
// returns to /settings?google=connected.
export async function connectGoogleAction(): Promise<ActionState> {
  const h = await headers();
  const origin =
    h.get("origin") ??
    (h.get("host") ? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}` : "https://compass-crm-ten.vercel.app");
  const { status, payload } = await callConnect({ mode: "start", return_to: `${origin}/settings` });
  const url = payload && typeof payload.url === "string" ? payload.url : null;
  if (!url) return { ok: false, message: errorOf(status, payload) };
  redirect(url);
}

export async function listGa4AccountsAction(_prev: Ga4AccountsState, _form: FormData): Promise<Ga4AccountsState> {
  const { status, payload } = await callConnect({ mode: "ga4_accounts" });
  const accounts = payload && Array.isArray(payload.accounts) ? (payload.accounts as Ga4Account[]) : null;
  if (!accounts) return { ok: false, message: errorOf(status, payload) };
  if (accounts.length === 0) return { ok: true, message: "The connected account can see no Analytics accounts.", accounts };
  return { ok: true, accounts };
}

export async function saveGa4AccountAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("id") ?? "").trim();
  const name = String(form.get("name") ?? "").trim() || null;
  if (!/^\d+$/.test(id)) return { ok: false, message: "Enter the numeric Analytics account id (Admin › Account settings)." };
  const { status, payload } = await callConnect({ mode: "ga4_account", id, name });
  if (!payload?.ok) return { ok: false, message: errorOf(status, payload) };
  revalidatePath("/settings");
  return { ok: true, message: `GA4 account ${id} stored. New properties are created under it.` };
}

export async function checkGoogleAccessAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  const { status, payload } = await callConnect({ mode: "access" });
  if (!payload || !Array.isArray(payload.clients)) return { ok: false, message: errorOf(status, payload) };
  revalidatePath("/settings");
  const rows = payload.clients as AccessRow[];
  const have = rows.filter((r) => r.gbp === "yes").length;
  return { ok: true, message: `Checked ${rows.length} clients: ${have} Business Profile${have === 1 ? "" : "s"} reachable.` };
}

// Business Profile publisher (0046): the switch and the pilot list. Off by
// default; the tick publishes only for clients named here, and Publish now
// takes the same check. Stored on app_settings 'publisher'.
export async function savePublisherSettingsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const enabled = form.get("enabled") === "on";
  const picked = form.getAll("clients").map(String).filter(isUuid);
  const { data: known, error: readError } = picked.length
    ? await supabase.from("clients").select("id").in("id", picked)
    : { data: [], error: null };
  if (readError) return { ok: false, message: readError.message };
  const clients = (known ?? []).map((c) => c.id).sort();
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "publisher", value: { enabled, clients } }, { onConflict: "key" });
  if (error) return { ok: false, message: error.message };
  revalidatePath("/settings");
  revalidatePath("/brief");
  return {
    ok: true,
    message: enabled
      ? `Publisher on for ${clients.length} client${clients.length === 1 ? "" : "s"}.`
      : "Publisher switched off. Nothing goes to Business Profiles.",
  };
}

// Worker Google operations (app_settings 'worker_google_ops'): whether the
// unattended worker may write to Google — Business Profile edits, GA4
// properties, Gmail drafts, Q&A, sitemap submissions. Separate from Connect
// Google (credentials only) and from the post publisher's own switch.
// google-ops and gsc-sync read it and refuse the worker while it is off.
export async function saveWorkerGoogleOpsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const member = await requireTeamMember(supabase);
  const enabled = form.get("enabled") === "on";
  const { error } = await supabase.from("app_settings").upsert(
    { key: "worker_google_ops", value: { enabled, changed_by: member.name, changed_at: new Date().toISOString() } },
    { onConflict: "key" }
  );
  if (error) return { ok: false, message: error.message };
  revalidatePath("/settings");
  return {
    ok: true,
    message: enabled
      ? "Worker Google operations on: the worker may now write to clients' Google properties."
      : "Worker Google operations off: the worker cannot write to Google. Read-only checks still run.",
  };
}

// Facebook through Zernio (Zernio Social Publisher v1). The post-publisher
// function reads Zernio with the publish key (never handed to the app) and
// binds an account only after re-reading it; the switch and the unbind are
// database functions that check the caller is a signed-in team admin.
async function callPublisher(body: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown> | null }> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { status: 401, payload: { error: "Not signed in." } };
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/post-publisher`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, payload: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (e) {
    return { status: 0, payload: { error: e instanceof Error ? e.message : "Could not reach the publisher." } };
  }
}

export async function verifyZernioAccountsAction(_prev: ActionState): Promise<ActionState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const { status, payload } = await callPublisher({ mode: "zernio_accounts" });
  const key = (payload?.key ?? null) as { ok?: boolean; detail?: string } | null;
  if (status !== 200 || !key?.ok) return { ok: false, message: key?.detail ?? (payload?.error as string) ?? `The publisher answered ${status}.` };
  const accounts = (payload?.zernio_accounts ?? []) as { zernio_account_id: string; name: string | null; selected_page_id: string | null; health: { status: string } }[];
  return {
    ok: true,
    message: accounts.length
      ? `Publish key works. Zernio sees: ${accounts.map((a) => `${a.name ?? "?"} (${a.zernio_account_id}, Page ${a.selected_page_id ?? "none"}, ${a.health.status})`).join("; ")}.`
      : "Publish key works, but it sees no Facebook account.",
  };
}

export async function bindZernioAccountAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const socialAccountId = form.get("social_account_id");
  const zernioAccountId = String(form.get("zernio_account_id") ?? "").trim();
  if (!isUuid(socialAccountId) || !/^[0-9a-f]{24}$/.test(zernioAccountId)) return { ok: false, message: "Give the Zernio account id (24 hex characters)." };
  const { status, payload } = await callPublisher({ mode: "zernio_bind", social_account_id: socialAccountId, zernio_account_id: zernioAccountId });
  revalidatePath("/settings");
  if (status !== 200) return { ok: false, message: (payload?.error as string) ?? `The publisher answered ${status}.` };
  return { ok: true, message: "Bound after verification. Publishing to this Page is still off until an admin switches it on." };
}

export async function setZernioPublishingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const id = form.get("social_account_id");
  const expected = String(form.get("expected_account_id") ?? "");
  const enabled = form.get("enabled") === "true";
  const what = form.get("kind") === "gbp" ? "Business Profile location" : "Page";
  if (!isUuid(id)) return { ok: false, message: "Unknown account." };
  const { error } = await supabase.rpc("publisher_set_account_enabled", { p_social_account_id: id, p_enabled: enabled, p_expected_account_id: expected });
  revalidatePath("/settings");
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: enabled ? `Publishing to this ${what} is on (the publisher switch and pilot list still apply).` : `Publishing to this ${what} is off.` };
}

export async function unbindZernioAccountAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const id = form.get("social_account_id");
  if (!isUuid(id)) return { ok: false, message: "Unknown account." };
  const { error } = await supabase.rpc("publisher_unbind_account", { p_social_account_id: id });
  revalidatePath("/settings");
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Binding removed." };
}

// Business Profile through Zernio. The publisher reads the googlebusiness
// accounts and their locations with the publish key; a binding names one
// client and one location and is made only after the function re-reads them.
export type GbpLocationView = { location_id: string | null; name: string | null; address: string | null; website: string | null };
export type GbpAccountsState = {
  ok: boolean;
  message?: string;
  accounts?: { zernio_account_id: string; name: string | null; active: boolean; health: { status: string }; selected_location_id: string | null; has_more: boolean | null; read: string; locations: GbpLocationView[] }[];
  matches?: { client_id: string; name: string; website_matches: { zernio_account_id: string; location_id: string | null; name: string | null }[] }[];
} | null;

export async function verifyZernioGbpAction(_prev: GbpAccountsState): Promise<GbpAccountsState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const { status, payload } = await callPublisher({ mode: "zernio_gbp_accounts" });
  const key = (payload?.key ?? null) as { ok?: boolean; detail?: string } | null;
  if (status !== 200 || !key?.ok) return { ok: false, message: key?.detail ?? (payload?.error as string) ?? `The publisher answered ${status}.` };
  const accounts = (payload?.zernio_accounts ?? []) as NonNullable<GbpAccountsState>["accounts"];
  const clients = (payload?.compass_clients ?? []) as NonNullable<GbpAccountsState>["matches"];
  return {
    ok: true,
    message: accounts?.length ? `Publish key works. It sees ${accounts.length} Google Business Profile account(s).` : "Publish key works, but it sees no Google Business Profile account. Connect the profile in Zernio first.",
    accounts, matches: clients,
  };
}

export async function bindZernioGbpAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const clientId = form.get("client_id");
  const zernioAccountId = String(form.get("zernio_account_id") ?? "").trim();
  const locationId = String(form.get("location_id") ?? "").trim();
  if (!isUuid(clientId) || !/^[0-9a-f]{24}$/.test(zernioAccountId) || !/^(locations\/)?[0-9]{1,30}$/.test(locationId)) {
    return { ok: false, message: "Give the Zernio account id (24 hex characters) and the location id (digits or locations/<id>)." };
  }
  const { status, payload } = await callPublisher({ mode: "zernio_gbp_bind", client_id: clientId, zernio_account_id: zernioAccountId, location_id: locationId });
  revalidatePath("/settings");
  if (status !== 200) return { ok: false, message: (payload?.error as string) ?? `The publisher answered ${status}.` };
  return { ok: true, message: "Bound after verification. Publishing to this location is still off until an admin switches it on." };
}

// A team admin returns a client's Business Profile posts to the direct Google
// path (or selects Zernio) explicitly. The database refuses google while a
// location is still bound, and anyone but a signed-in team admin.
export async function setGbpTransportAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const clientId = form.get("client_id");
  const transport = String(form.get("transport") ?? "");
  if (!isUuid(clientId) || (transport !== "google" && transport !== "zernio")) return { ok: false, message: "Unknown client or transport." };
  const { error } = await supabase.rpc("publisher_set_gbp_transport", { p_client_id: clientId, p_transport: transport });
  revalidatePath("/settings");
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: transport === "google"
    ? "This client's Business Profile posts now take the direct Google path."
    : "This client's Business Profile posts now go through Zernio only." };
}
