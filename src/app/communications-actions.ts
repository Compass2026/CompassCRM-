"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { callCommunications } from "@/lib/communications-call";
import { normalizeUsPhone, refusalText } from "@/lib/communications";

// Compass Communications (0063). Every action checks the caller is on the
// team first; the database's guards and the communications function check
// again (admin modes against team_members.role, consent under a lock). No
// Twilio credential is read, passed or returned here.

export type ActionState = { ok: boolean; message: string } | null;

const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";
const path = (clientId: string) => `/clients/${clientId}/communications`;
const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");
const orNull = (v: FormDataEntryValue | null) => text(v) || null;

async function team() {
  const supabase = await createClient();
  try {
    const member = await requireTeamMember(supabase);
    return { supabase, member };
  } catch {
    return null;
  }
}

function dbMessage(error: { message?: string; code?: string } | null): string {
  if (!error) return "Saved.";
  if (error.code === "42501") return refusalText(error.message) || "You can't do that.";
  return refusalText(error.message);
}

// ── Settings ────────────────────────────────────────────────────────────────
export async function saveCommunicationSettingsAction(clientId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(clientId)) return { ok: false, message: "Unknown client." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const enabled = form.get("enabled") === "on";
  const outbound = enabled && form.get("outbound_enabled") === "on";
  const row = { enabled, outbound_enabled: outbound, display_name: orNull(form.get("display_name")), notes: orNull(form.get("notes")) };
  const { data: existing } = await t.supabase.from("client_communication_settings").select("client_id").eq("client_id", clientId).maybeSingle();
  const { error } = existing
    ? await t.supabase.from("client_communication_settings").update(row).eq("client_id", clientId)
    : await t.supabase.from("client_communication_settings").insert({ client_id: clientId, ...row });
  revalidatePath(path(clientId), "layout");
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: "Saved." };
}

// ── Contacts and consent ────────────────────────────────────────────────────
export async function createContactAction(clientId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(clientId)) return { ok: false, message: "Unknown client." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const rawPhone = text(form.get("phone"));
  const phone = normalizeUsPhone(rawPhone);
  if (rawPhone && !phone) return { ok: false, message: "Enter a 10-digit US mobile number." };
  const email = orNull(form.get("email"));
  if (!phone && !email) return { ok: false, message: "A contact needs a mobile number or an email." };
  const { error } = await t.supabase.from("contacts").insert({
    client_id: clientId, first_name: orNull(form.get("first_name")), last_name: orNull(form.get("last_name")),
    company: orNull(form.get("company")), phone_e164: phone, email, notes: orNull(form.get("notes")), source: "manual",
  });
  revalidatePath(path(clientId), "layout");
  if (error?.code === "23505") return { ok: false, message: "A contact with that number already exists for this client." };
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: "Contact added. Consent is recorded separately." };
}

export async function updateContactAction(clientId: string, contactId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(clientId) || !isUuid(contactId)) return { ok: false, message: "Unknown contact." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const email = orNull(form.get("email"));
  const { error } = await t.supabase.from("contacts").update({
    first_name: orNull(form.get("first_name")), last_name: orNull(form.get("last_name")),
    company: orNull(form.get("company")), email,
  }).eq("id", contactId).eq("client_id", clientId);
  revalidatePath(path(clientId), "layout");
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: "Saved." };
}

export async function recordConsentAction(clientId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(clientId)) return { ok: false, message: "Unknown client." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const phone = normalizeUsPhone(text(form.get("phone")));
  if (!phone) return { ok: false, message: "Enter the recipient's mobile number." };
  const status = text(form.get("status")) === "revoked" ? "revoked" : "granted";
  const consentedAt = text(form.get("consented_at"));
  const contactId = text(form.get("contact_id"));
  const { error } = await t.supabase.rpc("communication_record_consent", {
    p: {
      client_id: clientId, phone_e164: phone, contact_id: isUuid(contactId) ? contactId : null,
      consent_type: "sms_customer_care", status, source: text(form.get("source")) || "other",
      source_url: orNull(form.get("source_url")), disclosure_version: orNull(form.get("disclosure_version")),
      evidence: orNull(form.get("evidence")),
      consented_at: consentedAt ? new Date(consentedAt).toISOString() : null,
    },
  });
  revalidatePath(path(clientId), "layout");
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: status === "granted" ? "Consent recorded." : "Consent revoked." };
}

// ── Inbox ───────────────────────────────────────────────────────────────────
export type SendResult = { ok: boolean; message: string; conversationId?: string };

export async function sendMessageAction(clientId: string, input: {
  requestId: string; body: string; conversationId?: string | null; contactId?: string | null;
}): Promise<SendResult> {
  if (!isUuid(clientId) || !isUuid(input.requestId)) return { ok: false, message: "Unknown client." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const r = await callCommunications(t.supabase, {
    mode: "send", client_id: clientId, request_id: input.requestId, body: input.body,
    conversation_id: input.conversationId && isUuid(input.conversationId) ? input.conversationId : null,
    contact_id: input.contactId && isUuid(input.contactId) ? input.contactId : null,
  });
  revalidatePath(path(clientId), "layout");
  const b = r.body ?? {};
  const conversationId = typeof b.conversation_id === "string" ? b.conversation_id : undefined;
  if (r.status === null) return { ok: false, message: "Could not reach the communications service. The message may not have been sent; check the thread before retrying." };
  if (r.status === 200 && b.status === "failed") {
    return { ok: false, conversationId, message: `Twilio refused the message${b.error_code ? ` (${b.error_code})` : ""}: ${String(b.error ?? "")}` };
  }
  if (r.status === 200) return { ok: true, conversationId, message: b.duplicate ? "Already sent." : "Sent." };
  if (r.status === 202) return { ok: true, conversationId, message: "Sending — Twilio has not confirmed yet." };
  return { ok: false, conversationId, message: refusalText(`${String(b.code ?? "")}: ${String(b.detail ?? b.error ?? "Not sent.")}`) };
}

export async function updateConversationAction(clientId: string, conversationId: string, patch: {
  mark_read?: boolean; status?: "open" | "closed"; assigned_user_id?: string | null;
}): Promise<ActionState> {
  if (!isUuid(clientId) || !isUuid(conversationId)) return { ok: false, message: "Unknown conversation." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const p: Record<string, unknown> = { conversation_id: conversationId };
  if (patch.mark_read) p.mark_read = true;
  if (patch.status) p.status = patch.status;
  if ("assigned_user_id" in patch) p.assigned_user_id = patch.assigned_user_id && isUuid(patch.assigned_user_id) ? patch.assigned_user_id : "";
  const { error } = await t.supabase.rpc("communication_update_conversation", { p: p as never });
  revalidatePath(path(clientId), "layout");
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: "Saved." };
}

// ── Numbers and the Twilio account (through the communications function) ──
const FUNCTION_MODES = ["check_parent", "create_subaccount", "link_subaccount", "create_messaging_service", "search_numbers",
  "purchase_number", "link_number", "attach_number", "sync_compliance"] as const;
export type FunctionMode = typeof FUNCTION_MODES[number];
export type FunctionResult = { ok: boolean; message: string; data?: Record<string, unknown> };

const DONE: Record<FunctionMode, string> = {
  check_parent: "Checked.",
  create_subaccount: "Subaccount created; its key and auth token are in Vault.",
  link_subaccount: "Subaccount linked; its key and auth token are in Vault.",
  create_messaging_service: "Messaging Service created.",
  search_numbers: "Search done. Nothing was purchased.",
  purchase_number: "Number purchased.",
  link_number: "Number linked.",
  attach_number: "Number added to the Messaging Service.",
  sync_compliance: "Synced with Twilio.",
};

export async function communicationsFunctionAction(clientId: string, mode: FunctionMode, payload: Record<string, string> = {}): Promise<FunctionResult> {
  if (!isUuid(clientId) || !FUNCTION_MODES.includes(mode)) return { ok: false, message: "Unknown request." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const r = await callCommunications(t.supabase, { ...payload, mode, client_id: clientId }, mode === "purchase_number" ? 60_000 : 30_000);
  revalidatePath(path(clientId), "layout");
  const b = r.body ?? {};
  if (r.status === null) return { ok: false, message: "Could not reach the communications service. Check Twilio before retrying a purchase." };
  if (r.status === 200) return { ok: true, message: DONE[mode], data: b };
  if (r.status === 207) return { ok: false, message: `Partly done: ${String(b.detail ?? "the subaccount's API key could not be created. Use “Store the subaccount's key and token again” to finish.")}`, data: b };
  if (r.status === 403 && b.code === "admin_only") return { ok: false, message: "Only a Compass admin can do this." };
  const twilio = b.twilio_code ? ` (Twilio ${String(b.twilio_code)})` : "";
  return { ok: false, message: `${String(b.error ?? b.detail ?? "Refused")}${twilio}`, data: b };
}

export async function setPrimaryNumberAction(clientId: string, numberId: string): Promise<ActionState> {
  if (!isUuid(clientId) || !isUuid(numberId)) return { ok: false, message: "Unknown number." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const { error } = await t.supabase.rpc("communication_set_primary_number", { p_number_id: numberId });
  revalidatePath(path(clientId), "layout");
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: "Primary number set." };
}

// ── Compliance ──────────────────────────────────────────────────────────────
const lines = (v: FormDataEntryValue | null) => text(v).split("\n").map((s) => s.trim()).filter(Boolean);

export async function saveRegistrationAction(clientId: string, profileId: string | null, profileType: "secondary_customer_profile" | "toll_free_verification",
  _prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(clientId) || (profileId && !isUuid(profileId))) return { ok: false, message: "Unknown registration." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const numberId = text(form.get("communication_number_id"));
  const row = {
    legal_business_name: orNull(form.get("legal_business_name")), doing_business_as: orNull(form.get("doing_business_as")),
    website_url: orNull(form.get("website_url")), address_street: orNull(form.get("address_street")), address_city: orNull(form.get("address_city")),
    address_region: orNull(form.get("address_region")), address_postal_code: orNull(form.get("address_postal_code")),
    business_contact_name: orNull(form.get("business_contact_name")), business_contact_email: orNull(form.get("business_contact_email")),
    business_contact_phone: normalizeUsPhone(text(form.get("business_contact_phone"))), notification_email: orNull(form.get("notification_email")),
    use_case_categories: lines(form.get("use_case_categories")), use_case_summary: orNull(form.get("use_case_summary")),
    sample_messages: lines(form.get("sample_messages")), message_volume: orNull(form.get("message_volume")),
    opt_in_type: orNull(form.get("opt_in_type")), opt_in_url: orNull(form.get("opt_in_url")), opt_in_image_urls: lines(form.get("opt_in_image_urls")),
    privacy_url: orNull(form.get("privacy_url")), terms_url: orNull(form.get("terms_url")),
    communication_number_id: profileType === "toll_free_verification" && isUuid(numberId) ? numberId : null,
  };
  const { error } = profileId
    ? await t.supabase.from("communication_compliance_profiles").update(row).eq("id", profileId).eq("client_id", clientId)
    : await t.supabase.from("communication_compliance_profiles").insert({ client_id: clientId, profile_type: profileType, ...row });
  revalidatePath(path(clientId), "layout");
  if (error?.code === "23514") return { ok: false, message: "Check the URLs (https) and the fields marked required." };
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: "Saved." };
}

export async function linkRegistrationAction(clientId: string, profileId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(clientId) || !isUuid(profileId)) return { ok: false, message: "Unknown registration." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const sid = text(form.get("provider_profile_sid"));
  const { error } = await t.supabase.from("communication_compliance_profiles").update({ provider_profile_sid: sid || null })
    .eq("id", profileId).eq("client_id", clientId);
  revalidatePath(path(clientId), "layout");
  if (error?.code === "23514") return { ok: false, message: "That is not the right kind of Twilio SID (BU… for a business profile, HH… for a toll-free verification)." };
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: "Linked. Sync with Twilio to read its status." };
}

export async function setRestrictionAction(clientId: string, profileId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(clientId) || !isUuid(profileId)) return { ok: false, message: "Unknown registration." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const r = text(form.get("restriction"));
  const restriction = r === "restricted" || r === "blocked" ? r : null;
  const { error } = await t.supabase.from("communication_compliance_profiles")
    .update({ restriction, restriction_reason: restriction ? orNull(form.get("restriction_reason")) : null })
    .eq("id", profileId).eq("client_id", clientId);
  revalidatePath(path(clientId), "layout");
  if (error?.code === "23514") return { ok: false, message: "Give the reason." };
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: restriction ? "Marked." : "Cleared." };
}

export async function ensureChecklistAction(clientId: string, profileId: string): Promise<ActionState> {
  if (!isUuid(clientId) || !isUuid(profileId)) return { ok: false, message: "Unknown registration." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const { error } = await t.supabase.rpc("communication_ensure_checklist", { p_profile_id: profileId });
  revalidatePath(path(clientId), "layout");
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: "Checklist added." };
}

export async function updateChecklistItemAction(clientId: string, itemId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(clientId) || !isUuid(itemId)) return { ok: false, message: "Unknown item." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const s = text(form.get("status"));
  const status = s === "done" || s === "not_applicable" ? s : "open";
  const { error } = await t.supabase.from("communication_compliance_items")
    .update({ status, evidence: orNull(form.get("evidence")) }).eq("id", itemId).eq("client_id", clientId);
  revalidatePath(path(clientId), "layout");
  if (error?.code === "23514") return { ok: false, message: "Say what shows it is done (a URL, a screenshot, where to look)." };
  return error ? { ok: false, message: dbMessage(error) } : { ok: true, message: "Saved." };
}
