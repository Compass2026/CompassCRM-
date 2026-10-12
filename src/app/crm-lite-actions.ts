"use server";

// CRM Lite setup (Client › Inquiries › Setup & alerts). Every action checks
// the caller is on the team first; the database's guards and functions check
// again (admins for the sender, the SMS switch and delivery tests; consent
// only as a signed-in teammate with every field). The intake token and the
// delivery test go through the crm-lite function, which holds Vault access;
// no Twilio credential or intake token is read here, and an issued token is
// returned once to the admin who asked.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { normalizeUsPhone } from "@/lib/communications";
import { refusalText } from "@/lib/inquiries";

export type CrmLiteState = { ok: boolean; message: string; token?: string; secretName?: string } | null;

const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";
const path = (clientId: string) => `/clients/${clientId}/inquiries/settings`;
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

function dbMessage(error: { message?: string; code?: string } | null, fallback = "Saved."): string {
  if (!error) return fallback;
  if (error.code === "23505") return "That already exists.";
  if (error.code === "23514") return "That combination isn't allowed (check the required fields).";
  return refusalText(error.message);
}

async function callCrmLite(supabase: Awaited<ReturnType<typeof createClient>>, body: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { status: 401, body: null as Record<string, unknown> | null };
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/crm-lite`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { status: null, body: null };
  }
}

// ── Settings ────────────────────────────────────────────────────────────────
export async function saveCrmLiteSettingsAction(clientId: string, _prev: CrmLiteState, form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId)) return { ok: false, message: "Unknown client." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const enabled = form.get("enabled") === "on";
  const row = { enabled, portal_enabled: enabled && form.get("portal_enabled") === "on", display_name: orNull(form.get("display_name")), notes: orNull(form.get("notes")) };
  const { data: existing } = await t.supabase.from("crm_lite_settings").select("client_id").eq("client_id", clientId).maybeSingle();
  const { error } = existing
    ? await t.supabase.from("crm_lite_settings").update(row).eq("client_id", clientId)
    : await t.supabase.from("crm_lite_settings").insert({ client_id: clientId, ...row });
  revalidatePath(`/clients/${clientId}/inquiries`, "layout");
  return { ok: !error, message: dbMessage(error) };
}

// ── Website sources ─────────────────────────────────────────────────────────
export async function createSourceAction(clientId: string, _prev: CrmLiteState, form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId)) return { ok: false, message: "Unknown client." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const key = text(form.get("source_key")).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(key)) return { ok: false, message: "Key: lower-case letters, digits and dashes (e.g. ginger-huff-website)." };
  const siteUrl = orNull(form.get("site_url"));
  if (siteUrl && !/^https:\/\//.test(siteUrl)) return { ok: false, message: "The site URL starts with https://." };
  const { error } = await t.supabase.from("inquiry_sources").insert({
    client_id: clientId, source_key: key, label: text(form.get("label")) || key, site_url: siteUrl, enabled: false,
    secret_name: "CRM_INTAKE_" + key.toUpperCase().replace(/-/g, "_"),
  });
  revalidatePath(path(clientId));
  return { ok: !error, message: dbMessage(error, "Source added (disabled). Issue its token, then enable it.") };
}

export async function setSourceEnabledAction(clientId: string, sourceId: string, enabled: boolean, _prev: CrmLiteState, _form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId) || !isUuid(sourceId)) return { ok: false, message: "Unknown source." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const { error } = await t.supabase.from("inquiry_sources").update({ enabled }).eq("id", sourceId).eq("client_id", clientId);
  revalidatePath(path(clientId));
  return { ok: !error, message: dbMessage(error, enabled ? "Source enabled." : "Source disabled.") };
}

export async function issueIntakeTokenAction(clientId: string, sourceId: string, _prev: CrmLiteState, _form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId) || !isUuid(sourceId)) return { ok: false, message: "Unknown source." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const r = await callCrmLite(t.supabase, { mode: "issue_intake_token", source_id: sourceId });
  revalidatePath(path(clientId));
  if (r.status === 200 && typeof r.body?.token === "string") {
    return { ok: true, message: "Token issued and stored in Vault. Copy it now; it is not shown again.", token: r.body.token, secretName: String(r.body.secret_name ?? "") };
  }
  if (r.status === 403) return { ok: false, message: "Only a Compass admin issues an intake token." };
  return { ok: false, message: r.status == null ? "Couldn't reach the crm-lite function." : `The crm-lite function answered ${r.status}.` };
}

// ── Alert sender (Compass-wide; admin) ──────────────────────────────────────
export async function saveSenderAction(senderId: string | null, clientId: string, _prev: CrmLiteState, form: FormData): Promise<CrmLiteState> {
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const phone = normalizeUsPhone(text(form.get("phone_e164")));
  if (!phone) return { ok: false, message: "Enter the sender's number." };
  const row = {
    label: text(form.get("label")) || "Compass alerts",
    provider_account_sid: text(form.get("provider_account_sid")),
    phone_e164: phone,
    messaging_service_sid: orNull(form.get("messaging_service_sid")),
    verification_status: text(form.get("verification_status")) || "pending_review",
    verification_sid: orNull(form.get("verification_sid")),
    verification_evidence: orNull(form.get("verification_evidence")),
    enabled: form.get("enabled") === "on",
  };
  const { error } = senderId && isUuid(senderId)
    ? await t.supabase.from("notification_senders").update(row).eq("id", senderId)
    : await t.supabase.from("notification_senders").insert({ ...row, sender_key: text(form.get("sender_key")) || "compass_notifications" });
  revalidatePath(path(clientId));
  if (error?.code === "42501") return { ok: false, message: "Only a Compass admin changes the alert sender." };
  return { ok: !error, message: dbMessage(error) };
}

export async function chooseSenderAction(clientId: string, _prev: CrmLiteState, form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId)) return { ok: false, message: "Unknown client." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const sender = text(form.get("sender_id"));
  const { error } = await t.supabase.rpc("crm_set_sms_sender", { p_client: clientId, p_sender: isUuid(sender) ? sender : (null as unknown as string) });
  revalidatePath(path(clientId));
  return { ok: !error, message: dbMessage(error, "Sender chosen. SMS alerts stay off until every gate is open.") };
}

// ── Recipients and consent ──────────────────────────────────────────────────
export async function addRecipientAction(clientId: string, _prev: CrmLiteState, form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId)) return { ok: false, message: "Unknown client." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const phone = normalizeUsPhone(text(form.get("phone")));
  if (!phone) return { ok: false, message: "Enter a 10-digit US mobile number." };
  const { error } = await t.supabase.from("notification_recipients").insert({
    client_id: clientId, phone_e164: phone, name: text(form.get("name")) || "Alert recipient",
    link_target: form.get("link_target") === "crm" ? "crm" : "portal",
  });
  revalidatePath(path(clientId));
  return { ok: !error, message: dbMessage(error, "Recipient added. Consent is pending until it is recorded.") };
}

export async function setRecipientEnabledAction(clientId: string, recipientId: string, enabled: boolean, _prev: CrmLiteState, _form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId) || !isUuid(recipientId)) return { ok: false, message: "Unknown recipient." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const { error } = await t.supabase.from("notification_recipients").update({ enabled }).eq("id", recipientId).eq("client_id", clientId);
  revalidatePath(path(clientId));
  return { ok: !error, message: dbMessage(error) };
}

export async function recordAlertConsentAction(clientId: string, recipientId: string, _prev: CrmLiteState, form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId) || !isUuid(recipientId)) return { ok: false, message: "Unknown recipient." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const status = form.get("status") === "revoked" ? "revoked" : "granted";
  const date = text(form.get("consented_at"));
  const { error } = await t.supabase.rpc("crm_record_notification_consent", { p: {
    recipient_id: recipientId,
    status,
    consented_at: date ? new Date(`${date}T12:00:00-05:00`).toISOString() : null,
    consent_method: orNull(form.get("consent_method")),
    consent_response: orNull(form.get("consent_response")),
    disclosure_version: orNull(form.get("disclosure_version")),
    disclosure_url: orNull(form.get("disclosure_url")),
    disclosure_acknowledged: form.get("disclosure_acknowledged") === "on",
    detail: orNull(form.get("detail")),
  } });
  revalidatePath(path(clientId));
  return { ok: !error, message: dbMessage(error, status === "granted" ? "Consent recorded." : "Consent revoked.") };
}

// ── Delivery test, confirmation, the switch (admin) ─────────────────────────
export async function sendDeliveryTestAction(clientId: string, recipientId: string, _prev: CrmLiteState, form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId) || !isUuid(recipientId)) return { ok: false, message: "Unknown recipient." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const requestId = text(form.get("request_id"));
  if (!isUuid(requestId)) return { ok: false, message: "Reload the page and try again." };
  const r = await callCrmLite(t.supabase, { mode: "send_test", recipient_id: recipientId, request_id: requestId });
  revalidatePath(path(clientId));
  if (r.status === 200) {
    const job = (r.body?.job ?? {}) as Record<string, unknown>;
    return { ok: true, message: `Test ${String(job.status ?? "queued")}${job.error_code ? ` (error ${job.error_code})` : ""}. Confirm once Twilio reports it delivered and the recipient has it.` };
  }
  if (r.status === 403) return { ok: false, message: "Only a Compass admin sends a delivery test." };
  if (r.status === 409) return { ok: false, message: refusalText(String(r.body?.detail ?? "blocked:")) };
  return { ok: false, message: r.status == null ? "Couldn't reach the crm-lite function." : `The crm-lite function answered ${r.status}.` };
}

export async function confirmDeliveryTestAction(clientId: string, recipientId: string, jobId: string, _prev: CrmLiteState, form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId) || !isUuid(recipientId) || !isUuid(jobId)) return { ok: false, message: "Unknown test." };
  if (form.get("received") !== "on") return { ok: false, message: "Confirm the recipient received the test text." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const { error } = await t.supabase.rpc("crm_confirm_delivery_test", { p_recipient: recipientId, p_job: jobId });
  revalidatePath(path(clientId));
  return { ok: !error, message: dbMessage(error, "Delivery test confirmed.") };
}

export async function setSmsAlertsAction(clientId: string, enabled: boolean, _prev: CrmLiteState, _form: FormData): Promise<CrmLiteState> {
  if (!isUuid(clientId)) return { ok: false, message: "Unknown client." };
  const t = await team();
  if (!t) return { ok: false, message: NOT_TEAM };
  const { error } = await t.supabase.rpc("crm_set_sms_alerts", { p_client: clientId, p_enabled: enabled });
  revalidatePath(`/clients/${clientId}/inquiries`, "layout");
  return { ok: !error, message: dbMessage(error, enabled ? "SMS alerts are on for new inquiries." : "SMS alerts are off.") };
}
