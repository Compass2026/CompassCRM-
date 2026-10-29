"use server";
// New Client Onboarding server actions. A server action is a public endpoint,
// so each one checks the team itself, scopes every write to the client in the
// URL, and lets the database guards (20261029170000) have the last word:
// only a signed-in teammate can mark an item verified, and a citation item is
// claimed / verified only when the Citation Tracker holds the listing.
// Nothing here contacts Google, Bing, Zernio or a directory.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { prepareUpdate } from "@/lib/client-onboarding";

export type OnboardingActionState = { error?: string; saved?: boolean; added?: number };

async function team(clientId: string) {
  if (!isUuid(clientId)) throw new Error("Invalid client. Refresh and try again.");
  const db = await createClient();
  if (!(await getCurrentTeamMember(db))) throw new Error("Only Compass team members can update onboarding.");
  return db;
}
function text(form: FormData, key: string, max: number) {
  const v = form.get(key);
  if (v === null) return "";
  if (typeof v !== "string" || v.trim().length > max) throw new Error(`Check ${key.replaceAll("_", " ")}.`);
  return v.trim();
}
// Guard messages (23514 / 42501) are written for people.
function dbError(e: { code?: string; message: string } | null, fallback: string) {
  if (!e) return;
  throw new Error(e.code === "23514" || e.code === "42501" ? e.message : fallback);
}
const failure = (e: unknown): OnboardingActionState => ({ error: e instanceof Error ? e.message : "Unable to save. Try again." });

/** Adds the rows the client is missing (new items, sites, locations). Never changes an existing row. */
export async function enrollOnboardingAction(clientId: string): Promise<OnboardingActionState> {
  try {
    const db = await team(clientId);
    const { data, error } = await db.rpc("enroll_client_onboarding", { p_client_id: clientId });
    dbError(error, "The checklist could not be started. Try again.");
    revalidatePath(`/clients/${clientId}/onboarding`);
    return { added: data ?? 0 };
  } catch (e) { return failure(e); }
}

export async function updateOnboardingItemAction(clientId: string, itemId: string, _prev: OnboardingActionState, form: FormData): Promise<OnboardingActionState> {
  try {
    if (!isUuid(itemId)) throw new Error("Invalid item. Refresh and try again.");
    const db = await team(clientId);
    const { data: item, error: readError } = await db.from("client_onboarding_overview")
      .select("id, client_id, citation_directory_key").eq("id", itemId).eq("client_id", clientId).maybeSingle();
    dbError(readError, "The item could not be read. Refresh and try again.");
    if (!item) throw new Error("That item is not on this client's checklist.");
    const update = prepareUpdate({
      status: text(form, "status", 40),
      evidence_url: text(form, "evidence_url", 2000),
      evidence_note: text(form, "evidence_note", 2000),
      blocking_reason: text(form, "blocking_reason", 1000),
      next_action: text(form, "next_action", 1000),
      due_on: text(form, "due_on", 10),
      required: form.get("required") === "on",
      listing: !!item.citation_directory_key,
    });
    const { error } = await db.from("client_onboarding_items").update(update).eq("id", itemId).eq("client_id", clientId);
    dbError(error, "The item could not be saved. Try again.");
    revalidatePath(`/clients/${clientId}/onboarding`);
    return { saved: true };
  } catch (e) { return failure(e); }
}
