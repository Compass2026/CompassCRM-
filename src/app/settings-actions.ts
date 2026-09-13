"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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
