"use server";

// CRM Lite follow-up: status and notes on an inquiry. Called from the agency
// workspace and from the client portal. A server action is a public
// endpoint, so it checks for a signed-in user here, and the database decides
// the rest: crm_inquiry_set_status / crm_inquiry_add_note accept a Compass
// teammate, or a portal contact of the inquiry's own client while its portal
// access is on (anyone else's inquiry looks missing). Every change is written
// to the inquiry's history with who and when.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/tasks";
import { isInquiryStatus, refusalCode, refusalText } from "@/lib/inquiries";

export type InquiryActionState = { ok: boolean; message: string } | null;

const SIGNED_OUT = "Your session expired. Sign in again and retry.";

// Only the two places these forms live are revalidated.
function safePath(path: string): string | null {
  return /^\/portal\/inquiries(\/[0-9a-f-]{36})?$/.test(path) || /^\/clients\/[0-9a-f-]{36}\/inquiries(\/[0-9a-f-]{36})?$/.test(path)
    ? path : null;
}

async function signedIn() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user ? supabase : null;
}

function refresh(path: string) {
  const p = safePath(path);
  if (!p) return;
  revalidatePath(p);
  revalidatePath(p.replace(/\/[0-9a-f-]{36}$/, ""));
}

export async function setInquiryStatusAction(
  inquiryId: string, expected: string, next: string, path: string, _prev: InquiryActionState, _form: FormData,
): Promise<InquiryActionState> {
  if (!isUuid(inquiryId) || !isInquiryStatus(expected) || !isInquiryStatus(next)) return { ok: false, message: "Unknown inquiry or status." };
  const supabase = await signedIn();
  if (!supabase) return { ok: false, message: SIGNED_OUT };
  const { error } = await supabase.rpc("crm_inquiry_set_status", { p_inquiry: inquiryId, p_status: next, p_expected: expected });
  refresh(path);
  if (error) return { ok: false, message: refusalCode(error.message) || error.code === "42501" ? refusalText(error.message) : "That didn't save. Try again." };
  return { ok: true, message: "Saved." };
}

export async function addInquiryNoteAction(inquiryId: string, path: string, _prev: InquiryActionState, form: FormData): Promise<InquiryActionState> {
  if (!isUuid(inquiryId)) return { ok: false, message: "Unknown inquiry." };
  const body = typeof form.get("body") === "string" ? String(form.get("body")).trim() : "";
  if (!body) return { ok: false, message: "Write a note first." };
  if (body.length > 5000) return { ok: false, message: "A note is at most 5,000 characters." };
  const supabase = await signedIn();
  if (!supabase) return { ok: false, message: SIGNED_OUT };
  const { error } = await supabase.rpc("crm_inquiry_add_note", { p_inquiry: inquiryId, p_body: body });
  refresh(path);
  if (error) return { ok: false, message: refusalText(error.message) };
  return { ok: true, message: "Note added." };
}
