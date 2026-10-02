import type { createClient } from "@/lib/supabase/server";
import {
  pipelineStatus,
  type ConsentStatus,
  type PipelineStatus,
  type RegistrationLike,
} from "@/lib/communications";

type Supabase = Awaited<ReturnType<typeof createClient>>;

// The Communications pages' reads (0063), all as the signed-in teammate under
// RLS. Nothing here writes, and no credential is ever read: whether Vault
// holds one is answered by secret_present() (yes / no only).

export type CommsSettings = { enabled: boolean; outbound_enabled: boolean; display_name: string | null; notes: string | null; updated_at: string };
export type CommsAccount = { id: string; provider_account_sid: string; friendly_name: string | null; status: string; created_at: string };
export type CommsService = { id: string; provider_service_sid: string; friendly_name: string; use_case: string; opt_out_mode: string; status: string };
export type CommsNumber = {
  id: string; provider_phone_number_sid: string; phone_number_e164: string; friendly_name: string | null; number_type: string;
  voice_enabled: boolean; sms_enabled: boolean; mms_enabled: boolean; is_primary: boolean; status: "active" | "released";
  messaging_service_id: string | null; purchased_at: string | null;
};
export type CommsRegistration = RegistrationLike & {
  id: string; provider_status: string | null; restriction_reason: string | null; restricted_at: string | null;
  legal_business_name: string | null; doing_business_as: string | null; website_url: string | null;
  address_street: string | null; address_city: string | null; address_region: string | null; address_postal_code: string | null; address_country: string | null;
  business_contact_name: string | null; business_contact_email: string | null; business_contact_phone: string | null; notification_email: string | null;
  use_case_categories: string[]; use_case_summary: string | null; sample_messages: string[]; message_volume: string | null;
  opt_in_type: string | null; opt_in_url: string | null; opt_in_image_urls: string[]; privacy_url: string | null; terms_url: string | null;
  submitted_at: string | null; approved_at: string | null; rejected_at: string | null; rejection_code: string | null; rejection_reason: string | null;
  edit_allowed: boolean | null; last_synced_at: string | null; created_at: string;
};
export type ChecklistItem = { id: string; profile_id: string; item_key: string; label: string; sort_order: number; status: "open" | "done" | "not_applicable"; evidence: string | null; checked_at: string | null; checked_by: string | null };

export type CommsSetup = {
  settings: CommsSettings | null;
  account: CommsAccount | null;
  services: CommsService[];
  numbers: CommsNumber[];
  registrations: CommsRegistration[];
  pipeline: PipelineStatus;
  primary: CommsNumber | null;
};

export async function loadCommsSetup(supabase: Supabase, clientId: string): Promise<CommsSetup> {
  const [settings, account, services, numbers, registrations] = await Promise.all([
    supabase.from("client_communication_settings").select("enabled, outbound_enabled, display_name, notes, updated_at").eq("client_id", clientId).maybeSingle(),
    supabase.from("communication_accounts").select("id, provider_account_sid, friendly_name, status, created_at").eq("client_id", clientId).maybeSingle(),
    supabase.from("communication_messaging_services").select("id, provider_service_sid, friendly_name, use_case, opt_out_mode, status").eq("client_id", clientId).order("created_at"),
    supabase.from("communication_numbers").select("id, provider_phone_number_sid, phone_number_e164, friendly_name, number_type, voice_enabled, sms_enabled, mms_enabled, is_primary, status, messaging_service_id, purchased_at")
      .eq("client_id", clientId).order("is_primary", { ascending: false }).order("created_at"),
    supabase.from("communication_compliance_profiles").select("*").eq("client_id", clientId).order("profile_type").order("created_at"),
  ]);
  const nums = (numbers.data ?? []) as CommsNumber[];
  const regs = (registrations.data ?? []) as unknown as CommsRegistration[];
  const active = nums.filter((n) => n.status === "active");
  return {
    settings: (settings.data as CommsSettings | null) ?? null,
    account: (account.data as CommsAccount | null) ?? null,
    services: (services.data ?? []) as CommsService[],
    numbers: nums,
    registrations: regs,
    pipeline: pipelineStatus({ hasAccount: !!account.data, registrations: regs, numbers: nums }),
    primary: active.find((n) => n.is_primary) ?? active[0] ?? null,
  };
}

export type ConversationRow = {
  id: string; status: "open" | "closed"; last_message_at: string | null; last_message_preview: string | null; last_direction: string | null;
  unread_count: number; assigned_user_id: string | null; communication_number_id: string;
  contact: { id: string; first_name: string | null; last_name: string | null; company: string | null; phone_e164: string | null; email: string | null } | null;
};

export async function loadConversations(supabase: Supabase, clientId: string, filter: "open" | "unread" | "closed" | "all" = "open"): Promise<ConversationRow[]> {
  let q = supabase.from("communication_conversations")
    .select("id, status, last_message_at, last_message_preview, last_direction, unread_count, assigned_user_id, communication_number_id, contact:contacts!communication_conversations_contact_id_client_id_fkey(id, first_name, last_name, company, phone_e164, email)")
    .eq("client_id", clientId).order("last_message_at", { ascending: false, nullsFirst: false }).limit(200);
  if (filter === "open") q = q.eq("status", "open");
  if (filter === "closed") q = q.eq("status", "closed");
  if (filter === "unread") q = q.gt("unread_count", 0);
  const { data } = await q;
  return (data ?? []) as unknown as ConversationRow[];
}

export type MessageRow = {
  id: string; direction: "inbound" | "outbound"; body: string; provider_status: string; error_code: string | null; error_message: string | null;
  opt_out_type: string | null; sent_at: string | null; delivered_at: string | null; created_at: string; sent_by: string | null; from_e164: string; to_e164: string;
};

export async function loadMessages(supabase: Supabase, clientId: string, conversationId: string): Promise<MessageRow[]> {
  const { data } = await supabase.from("communication_messages")
    .select("id, direction, body, provider_status, error_code, error_message, opt_out_type, sent_at, delivered_at, created_at, sent_by, from_e164, to_e164")
    .eq("client_id", clientId).eq("conversation_id", conversationId).order("created_at").limit(500);
  return (data ?? []) as MessageRow[];
}

export type ConsentRow = {
  id: string; consent_type: string; status: ConsentStatus; source: string; source_url: string | null; disclosure_version: string | null;
  evidence: string | null; consented_at: string | null; revoked_at: string | null; updated_at: string;
};
export type ConsentEventRow = { id: string; consent_type: string; from_status: string | null; to_status: string; source: string; evidence: string | null; actor_kind: string; created_at: string };

export async function loadConsent(supabase: Supabase, clientId: string, phone: string | null): Promise<{ consents: ConsentRow[]; events: ConsentEventRow[] }> {
  if (!phone) return { consents: [], events: [] };
  const [c, e] = await Promise.all([
    supabase.from("communication_consents").select("id, consent_type, status, source, source_url, disclosure_version, evidence, consented_at, revoked_at, updated_at")
      .eq("client_id", clientId).eq("phone_e164", phone).order("consent_type"),
    supabase.from("communication_consent_events").select("id, consent_type, from_status, to_status, source, evidence, actor_kind, created_at")
      .eq("client_id", clientId).eq("phone_e164", phone).order("created_at", { ascending: false }).limit(20),
  ]);
  return { consents: (c.data ?? []) as ConsentRow[], events: (e.data ?? []) as ConsentEventRow[] };
}

export async function loadChecklist(supabase: Supabase, clientId: string): Promise<ChecklistItem[]> {
  const { data } = await supabase.from("communication_compliance_items")
    .select("id, profile_id, item_key, label, sort_order, status, evidence, checked_at, checked_by").eq("client_id", clientId).order("sort_order");
  return (data ?? []) as ChecklistItem[];
}

// Whether the Vault holds a credential — names only, answered yes / no.
export async function credentialPresence(supabase: Supabase, accountSid: string | null) {
  const names = ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY", "TWILIO_API_SECRET"];
  if (accountSid) names.push(`TWILIO_SUB_${accountSid}_API_KEY`, `TWILIO_SUB_${accountSid}_API_SECRET`, `TWILIO_SUB_${accountSid}_AUTH_TOKEN`);
  const answers = await Promise.all(names.map((n) => supabase.rpc("secret_present", { secret_name: n })));
  const present = Object.fromEntries(names.map((n, i) => [n, answers[i].data === true]));
  return {
    parent: present.TWILIO_ACCOUNT_SID && present.TWILIO_API_KEY && present.TWILIO_API_SECRET,
    subaccountKey: accountSid ? present[`TWILIO_SUB_${accountSid}_API_KEY`] && present[`TWILIO_SUB_${accountSid}_API_SECRET`] : false,
    webhookToken: accountSid ? present[`TWILIO_SUB_${accountSid}_AUTH_TOKEN`] : false,
  };
}

export function contactName(c: { first_name: string | null; last_name: string | null; company?: string | null } | null): string | null {
  if (!c) return null;
  const n = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return n || c.company || null;
}

export async function isAdmin(supabase: Supabase): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from("team_members").select("role").eq("auth_user_id", user.id).maybeSingle();
  return data?.role === "admin";
}
