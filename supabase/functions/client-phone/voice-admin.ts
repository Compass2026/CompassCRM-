import type { DB } from "../client-mailbox/handler.ts";
import { uuid, email } from "../client-mailbox/mail.ts";
import { voiceProvider, sid } from "./voice-provider.ts";

export async function voiceRecipients(db: DB, cid: string) {
  const [team, portal] = await Promise.all([
    db.from("team_members").select("auth_user_id,email"),
    db.from("portal_users").select("auth_user_id,email").eq("client_id", cid).eq("is_active", true),
  ]);
  if (team.error || portal.error) throw Error("database_unavailable");
  return [...new Map([...(team.data || []), ...(portal.data || [])]
    .filter(u => uuid(u.auth_user_id) && email(u.email))
    .map(u => [u.auth_user_id, { id: u.auth_user_id, email: u.email }])).values()];
}

export async function voiceAdmin(db: DB, cid: string, uid: string, input: DB, base: string, request: typeof fetch) {
  const member = await db.from("team_members").select("role").eq("auth_user_id", uid).maybeSingle();
  if (member.error || member.data?.role !== "admin") throw Error("forbidden");
  async function one(t: string, filters: DB) {
    let q = db.from(t).select("*");
    for (const [k,v] of Object.entries(filters)) q = q.eq(k,v);
    const r = await q.maybeSingle(); if (r.error) throw Error("database_unavailable"); return r.data;
  }
  async function save(values: DB) {
    const r = await db.from("client_voice_settings").upsert({ client_id: cid, ...values, updated_by: uid, updated_at: new Date().toISOString() });
    if (r.error) throw Error("invalid_settings");
  }
  const settings = await one("client_voice_settings", { client_id: cid });
  const account = await one("communication_accounts", { client_id: cid, provider: "twilio", status: "active" });
  const number = await one("communication_numbers", { client_id: cid, is_primary: true, status: "active" });
  const mailbox = await one("client_mailboxes", { client_id: cid });
  const recipients = await voiceRecipients(db,cid);
  if (input.mode === "voice_setup") return { settings, recipients, number: number?.phone_number_e164 || null,
    account_ready: !!account, number_ready: !!number?.voice_enabled,
    email_ready: !!(mailbox?.enabled && mailbox.provider === "resend" && mailbox.resend_ready),
    inbound_webhook: base + "/functions/v1/client-voice-webhook/inbound" };
  if (!account) throw Error("provider_not_ready");
  const provider = await voiceProvider(db, account.provider_account_sid, request);
  if (input.mode === "provision_voice") {
    // Discover existing resources before creation so a lost response does not duplicate them.
    const name = `Compass CRM ${cid}`;
    const apps = await provider.call("/Applications.json?PageSize=1000");
    let app = (apps.applications || []).find((a: DB) => a.sid === settings?.application_sid || a.friendly_name === name);
    if (!app) app = await provider.call("/Applications.json", "POST", { FriendlyName: name,
      VoiceUrl: base + "/functions/v1/client-voice-webhook/outbound", VoiceMethod: "POST" });
    else if(app.voice_url !== base + "/functions/v1/client-voice-webhook/outbound")
      await provider.call(`/Applications/${app.sid}.json`,"POST",{VoiceUrl:base+"/functions/v1/client-voice-webhook/outbound",VoiceMethod:"POST"});
    if (!sid(app.sid, "AP")) throw Error("provider_not_ready");
    await save({ application_sid: app.sid });
    return { saved: true };
  }
  if (input.mode === "provision_summaries") {
    const name = `compass-${cid}`;
    const services = await provider.call("/Services?PageSize=1000", "GET", undefined, true);
    let service = (services.services || []).find((s: DB) => s.unique_name === name);
    if (!service) service = await provider.call("/Services", "POST", {
      UniqueName: name, FriendlyName: "Compass lead call summaries", LanguageCode: "en-US",
      AutoTranscribe: "false", DataLogging: "false", AutoRedaction: "true",
    }, true);
    if (!sid(service.sid,"GA") || service.account_sid !== account.provider_account_sid || service.auto_transcribe || service.data_logging)
      throw Error("provider_not_ready");
    const ops = await provider.call("/Operators/PreBuilt?PageSize=1000", "GET", undefined, true);
    const summary = (ops.pre_built_operators || ops.prebuilt_operators || ops.operators || [])
      .find((o: DB) => /^(conversation summary|summari[sz]ation)$/i.test(o.friendly_name || "") && o.availability !== "retired");
    if (!summary || !sid(summary.sid,"LY")) throw Error("summary_operator_unavailable");
    const attached = await provider.call(`/Services/${service.sid}/Operators`, "GET", undefined, true);
    if (!(attached.operator_sids || []).includes(summary.sid))
      await provider.call(`/Services/${service.sid}/Operators/${summary.sid}`, "POST", {}, true);
    await save({ intelligence_service_sid: service.sid, summary_operator_sid: summary.sid });
    return { saved: true };
  }
  if (input.mode === "save_voice_settings") {
    const v = input.settings;
    if (!v || ["enabled","recording_enabled","summaries_enabled","email_summaries"].some(k => typeof v[k] !== "boolean") ||
      !Number.isInteger(v.retention_days) || v.retention_days < 7 || v.retention_days > 365 ||
      !Array.isArray(v.summary_user_ids) || v.summary_user_ids.length > 10 ||
      v.summary_user_ids.some((id: string) => !recipients.some(r => r.id === id))) throw Error("invalid_settings");
    if (v.enabled && (!settings?.application_sid || !number?.voice_enabled)) throw Error("voice_not_ready");
    if (v.summaries_enabled && (!v.recording_enabled || !settings?.intelligence_service_sid || !settings.summary_operator_sid)) throw Error("summaries_not_ready");
    if (v.email_summaries && (!v.summaries_enabled || !v.summary_user_ids.length || !mailbox?.resend_ready || !mailbox.enabled || mailbox.provider !== "resend")) throw Error("email_not_ready");
    await save({ enabled: v.enabled, recording_enabled: v.recording_enabled, summaries_enabled: v.summaries_enabled,
      email_summaries: v.email_summaries, retention_days: v.retention_days, summary_user_ids: [...new Set(v.summary_user_ids)] });
    return { saved: true };
  }
  // Routing changes are a separate explicit action. Preserve the previous TwiML fallback.
  if (input.mode === "route_inbound") {
    if (!settings?.enabled || !number?.voice_enabled || !sid(number.provider_phone_number_sid,"PN")) throw Error("voice_not_ready");
    const current = await provider.call(`/IncomingPhoneNumbers/${number.provider_phone_number_sid}.json`);
    let fallback=settings.fallback_url;
    if (current.voice_url && current.voice_url !== base + "/functions/v1/client-voice-webhook/inbound" &&
      /^https:\/\/handler\.twilio\.com\/twiml\/EH[0-9a-fA-F]{32}$/.test(current.voice_url)) {await save({ fallback_url: current.voice_url });fallback=current.voice_url;}
    else if (current.voice_url && current.voice_url !== base + "/functions/v1/client-voice-webhook/inbound" && !settings.fallback_url)
      throw Error("fallback_review_required");
    await provider.call(`/IncomingPhoneNumbers/${number.provider_phone_number_sid}.json`, "POST", {
      VoiceUrl: base + "/functions/v1/client-voice-webhook/inbound", VoiceMethod: "POST",
      ...(fallback ? { VoiceFallbackUrl: fallback, VoiceFallbackMethod: "POST" } : {}),
    });
    return { saved: true };
  }
  throw Error("invalid_settings");
}
