import { voiceIdentity } from "./identity.ts";
import { uuid } from "../client-mailbox/mail.ts";
import type { DB } from "../client-mailbox/handler.ts";
import { createTwilioProvider } from "../_shared/communications/twilio.ts";
import { ProviderError } from "../_shared/communications/provider.ts";
import { voiceAdmin } from "./voice-admin.ts";
import { voiceProvider, sid } from "./voice-provider.ts";
import { findSent, listingCovers } from "../crm-lite/handler.ts";
const reply = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const E164 = /^\+[1-9][0-9]{7,14}$/;
// An unconfirmed send is checked with Twilio only after this long (a send in
// flight takes at most the provider's 20 s timeout plus the function's work),
// over this many of the latest messages, allowing this much clock skew.
export const RECONCILE_AFTER_MS = 90_000;
const RECONCILE_PAGE = 50;
const CLOCK_SKEW_MS = 120_000;
// Refusals client_phone_begin_sms raises ("code: detail" or a bare code),
// passed to the page by code so it can say what to do.
export const SMS_REFUSALS = [
  "verification_required", "save_draft_first", "send_uncertain_refresh_first", "no_consent", "opted_out",
  "outbound_disabled", "not_enabled", "no_phone", "lead_contact_mismatch", "no_number", "no_messaging_service",
  "empty", "too_long",
] as const;
export function smsRefusal(message: string | null | undefined): string {
  const code = (/^([a-z_]+)(?::|$)/.exec(message ?? "") ?? [])[1];
  return code && (SMS_REFUSALS as readonly string[]).includes(code) ? code : "send_not_ready";
}
export function createClientPhone(
  db: DB,
  base: string,
  mint: (config: {
    account: string;
    key: string;
    secret: string;
    app: string;
    identity: string;
  }) => string,
  request: typeof fetch = fetch,
) {
  async function one(
    table: string,
    filters: Record<string, unknown>,
    columns = "*",
  ) {
    let q = db.from(table).select(columns);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const r = await q.maybeSingle();
    if (r.error) throw Error("database_unavailable");
    return r.data;
  }
  async function check(q: DB) {
    const r = await q;
    if (r.error) throw Error("database_unavailable");
    return r.data;
  }
  async function actor(uid: string, cid: string) {
    const [c, s, m, p] = await Promise.all([
      one("clients", { id: cid }, "status"),
      one("crm_lite_settings", { client_id: cid }, "enabled,portal_enabled"),
      one("team_members", { auth_user_id: uid }, "id"),
      one(
        "portal_users",
        { auth_user_id: uid, client_id: cid, is_active: true },
        "id",
      ),
    ]);
    if (
      !c ||
      ["paused", "offboarded"].includes(c.status) ||
      !s?.enabled ||
      (!m && (!p || !s.portal_enabled))
    )
      throw Error("forbidden");
  }
  async function snapshot(cid: string, i: DB, uid: string) {
    // The lead's thread is the one with the contact holding the lead's own
    // number (unique per client), the number texts go to; never the thread
    // of whatever contact the inquiry happens to link.
    const recipient = i.phone_e164 && E164.test(i.phone_e164) ? i.phone_e164 : null;
    const holder = recipient ? await one("contacts", { client_id: cid, phone_e164: recipient }, "id") : null;
    const [draft, settings, profile, number, consent, convs, voice, calls] =
      await Promise.all([
        one(
          "client_phone_drafts",
          { client_id: cid, inquiry_id: i.id, actor_id: uid },
          "body,revision",
        ),
        one(
          "client_communication_settings",
          { client_id: cid },
          "enabled,outbound_enabled",
        ),
        check(
          db
            .from("communication_compliance_profiles")
            .select("status,rejection_reason")
            .eq("client_id", cid)
            .eq("profile_type", "toll_free_verification")
            .limit(1),
        ),
        one(
          "communication_numbers",
          { client_id: cid, is_primary: true, status: "active" },
          "phone_number_e164",
        ),
        recipient
          ? check(
              db
                .from("communication_consents")
                .select("status,consent_type")
                .eq("client_id", cid)
                .eq("phone_e164", recipient),
            )
          : [],
        holder
          ? check(
              db
                .from("communication_conversations")
                .select("id")
                .eq("client_id", cid)
                .eq("contact_id", holder.id),
            )
          : [],
        one(
          "client_voice_settings",
          { client_id: cid },
          "enabled,application_sid",
        ),
        check(
          db
            .from("client_voice_calls")
            .select("id,direction,status,duration,created_at")
            .eq("client_id", cid)
            .eq("inquiry_id", i.id)
            .order("created_at", { ascending: false })
            .limit(50),
        ),
      ]);
    const messages = convs.length
      ? await check(
          db
            .from("communication_messages")
            .select("id,direction,body,provider_status,created_at")
            .eq("client_id", cid)
            .in(
              "conversation_id",
              convs.map((v: DB) => v.id),
            )
            .order("created_at", { ascending: false })
            .limit(100),
        )
      : [];
    const reason = !number
      ? "Business number setup is incomplete."
      : profile[0]?.status !== "approved"
        ? "Texting is awaiting carrier verification."
        : !settings?.enabled || !settings.outbound_enabled
          ? "Text sending has not been enabled."
          : !recipient
            ? "This lead didn't give a valid mobile number, so they can't be texted. Call or email instead."
            : !holder
              ? "This lead's number isn't linked to a contact yet. Ask your Compass team to repair the lead before texting."
            : consent.some((v: DB) => v.status === "opted_out")
              ? "This lead opted out of texts."
              : !consent.some(
                    (v: DB) =>
                      v.consent_type === "sms_customer_care" &&
                      v.status === "granted",
                  )
                ? "This lead needs recorded permission for text messages."
                : null;
    const recordings = calls.length ? await check(db.from("client_voice_recordings")
      .select("id,call_id,state,duration,summary,expires_at,error_code")
      .eq("client_id",cid).in("call_id",calls.map((c: DB)=>c.id)).neq("state","deleted").gt("expires_at",new Date().toISOString())) : [];
    return {
      draft,
      messages: messages.reverse(),
      calls: calls.map((c: DB)=>({...c,recordings:recordings.filter((r: DB)=>r.call_id===c.id)})),
      number: number?.phone_number_e164 || null,
      recipient,
      can_send: !reason,
      reason,
      voice_ready: !!(voice?.enabled && voice.application_sid && number),
    };
  }
  // ── Sending ──────────────────────────────────────────────────────────────
  // One press of Send = one request id, chosen by the composer and reused
  // only to ask about the same press again. The id is the database's dedupe
  // key (communication_messages.request_id), so a second request with it
  // never reserves or sends a second text. Outcomes:
  //   accepted   Twilio took it (it has a MessageSid); delivery follows
  //   failed     Twilio refused it, or Compass knows it was never sent
  //   uncertain  Compass cannot tell yet; ask again with the same id later
  type SendResult = { state: "accepted" | "failed" | "uncertain"; message_id?: string; code?: string };
  const twilioCredential = async (accountSid: string) => {
    const r = await db.rpc("communication_subaccount_secrets", { p_account_sid: accountSid });
    if (r.error || !r.data?.api_key || !r.data.api_secret) return null;
    return { scope: "subaccount" as const, accountSid, keySid: r.data.api_key as string, keySecret: r.data.api_secret as string };
  };
  const outcome = (m: DB): SendResult =>
    m.provider_message_sid
      ? { state: "accepted", message_id: m.id }
      : m.provider_status === "pending"
        ? { state: "uncertain", message_id: m.id, code: "send_uncertain" }
        : { state: "failed", message_id: m.id, code: m.error_code === "not_sent" ? "not_sent" : "provider_refused" };

  // A reservation with no MessageSid is either still in flight or its
  // answer was lost. Only once it is older than any send can take
  // (RECONCILE_AFTER_MS) is Twilio asked; the same check crm-lite uses for
  // its alerts (exact text, same numbers, created at or after the attempt).
  async function reconcile(cid: string, m: DB): Promise<SendResult> {
    if (Date.now() - Date.parse(m.created_at) < RECONCILE_AFTER_MS) return outcome(m);
    const account = await one("communication_accounts", { client_id: cid, provider: "twilio", status: "active" }, "provider_account_sid");
    const cred = account && await twilioCredential(account.provider_account_sid);
    if (!cred) return outcome(m);
    let listed;
    try {
      listed = await createTwilioProvider(request).listMessages(cred, { to: m.to_e164, from: m.from_e164, pageSize: RECONCILE_PAGE });
    } catch {
      return outcome(m);
    }
    const since = new Date(Date.parse(m.created_at) - CLOCK_SKEW_MS).toISOString();
    const hit = findSent(listed.messages, m.body, since);
    if (hit) {
      await check(db.rpc("communication_mark_sent", { p: { message_id: m.id, provider_message_sid: hit.sid, provider_status: hit.status } }));
      return { state: "accepted", message_id: m.id };
    }
    if (listingCovers(listed.messages, listed.complete, since)) {
      await check(db.rpc("communication_mark_sent", { p: { message_id: m.id, error_code: "not_sent",
        error_message: "Twilio has no record of this text; it was not sent" } }));
      return { state: "failed", message_id: m.id, code: "not_sent" };
    }
    return outcome(m);
  }

  async function sendText(cid: string, i: DB, uid: string, input: DB): Promise<SendResult> {
    // A page loaded before this change sends {revision} after Save draft: its
    // saved draft's revision is the request id and its text the body.
    if (input.request_id == null && uuid(input.revision)) {
      const d = await one("client_phone_drafts", { client_id: cid, inquiry_id: i.id, actor_id: uid, revision: input.revision }, "body");
      const sent = !d && await one("communication_messages", { request_id: input.revision }, "id");
      if (!d && !sent) throw Error("save_draft_first");
      input = { ...input, request_id: input.revision, body: d ? d.body : "" };
    }
    if (!uuid(input.request_id)) throw Error("invalid_request");
    const cols = "id,client_id,inquiry_id,client_actor_id,body,to_e164,from_e164,provider_status,provider_message_sid,error_code,created_at";
    // The same press asked again: report or reconcile it, never send again.
    const same = await one("communication_messages", { request_id: input.request_id }, cols);
    if (same) {
      if (same.client_id !== cid || same.inquiry_id !== i.id || same.client_actor_id !== uid) throw Error("invalid_request");
      const r = same.provider_message_sid || same.provider_status !== "pending" ? outcome(same) : await reconcile(cid, same);
      if (r.state === "accepted") await clearDraft(cid, i.id, uid, input.request_id);
      return r;
    }
    if (typeof input.body !== "string" || !input.body.trim()) throw Error("empty");
    if (input.body.length > 1600) throw Error("too_long");
    // An earlier press on this lead whose result is unknown blocks a new
    // text until Twilio says what happened to it.
    const open = await check(db.from("communication_messages").select(cols)
      .eq("client_id", cid).eq("inquiry_id", i.id).eq("provider_status", "pending").is("provider_message_sid", null));
    for (const m of open) {
      const r = await reconcile(cid, m);
      if (r.state === "uncertain") throw Error("send_uncertain_refresh_first");
    }
    // Saved as part of the send: the database sends exactly this saved text
    // for this request id (client_phone_begin_sms reads the draft).
    await check(db.from("client_phone_drafts").upsert(
      { client_id: cid, inquiry_id: i.id, actor_id: uid, body: input.body, revision: input.request_id, updated_at: new Date().toISOString() },
      { onConflict: "client_id,inquiry_id,actor_id" },
    ));
    const begun = await db.rpc("client_phone_begin_sms", {
      p: { client_id: cid, inquiry_id: i.id, actor_id: uid, request_id: input.request_id },
    });
    if (begun.error) throw Error(smsRefusal(begun.error.message));
    const b = begun.data;
    if (b.duplicate) {
      // Another request with this id got there first (a double press).
      const m = await one("communication_messages", { id: b.message_id }, cols);
      return m ? outcome(m) : { state: "uncertain", message_id: b.message_id, code: "send_uncertain" };
    }
    const cred = await twilioCredential(b.account_sid);
    if (!cred) return { state: "uncertain", message_id: b.message_id, code: "send_uncertain" };
    try {
      const s = await createTwilioProvider(request).sendMessage(cred, {
        messagingServiceSid: b.messaging_service_sid, to: b.to, body: b.body,
        statusCallbackUrl: base + "/functions/v1/twilio-webhook/messages/status?m=" + b.message_id,
      });
      await check(db.rpc("communication_mark_sent", { p: { message_id: b.message_id, provider_message_sid: s.sid,
        provider_status: s.status, error_code: s.errorCode, error_message: s.errorMessage } }));
    } catch (e) {
      if (e instanceof ProviderError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        await check(db.rpc("communication_mark_sent", { p: { message_id: b.message_id,
          error_code: e.code || String(e.status), error_message: e.message } }));
        // The draft stays: the composer keeps the text for another try.
        return { state: "failed", message_id: b.message_id, code: "provider_refused" };
      }
      // A 5xx, a 429, a timeout or no answer: Twilio may have it. Ask again later.
      return { state: "uncertain", message_id: b.message_id, code: "send_uncertain" };
    }
    await clearDraft(cid, i.id, uid, input.request_id);
    return { state: "accepted", message_id: b.message_id };
  }
  async function clearDraft(cid: string, iid: string, uid: string, revision: string) {
    await check(db.from("client_phone_drafts").delete()
      .eq("client_id", cid).eq("inquiry_id", iid).eq("actor_id", uid).eq("revision", revision));
  }

  return async (req: Request) => {
    if (req.method !== "POST")
      return reply(405, { error: "method_not_allowed" });
    try {
      const raw = await req.text();
      if (raw.length > 20000) return reply(413, { error: "too_large" });
      const input = JSON.parse(raw),
        cid = input.client_id;
      if (!uuid(cid)) return reply(400, { error: "invalid_client" });
      const auth = req.headers.get("authorization") || "";
      const { data, error } = await db.auth.getUser(
        auth.startsWith("Bearer ") ? auth.slice(7) : "",
      );
      if (error || !data?.user) return reply(401, { error: "unauthorized" });
      const uid = data.user.id;
      await actor(uid, cid);
      if (["voice_setup","provision_voice","provision_summaries","save_voice_settings","route_inbound"].includes(input.mode))
        return reply(200, await voiceAdmin(db,cid,uid,input,base,request));
      if (input.mode === "voice_status") {
        const v = await one("client_voice_settings",{client_id:cid});
        const n = await one("communication_numbers",{client_id:cid,is_primary:true,status:"active"});
        return reply(200,{ enabled: !!(v?.enabled && v.application_sid && n?.voice_enabled), number:n?.phone_number_e164 || null,
          recording_enabled: !!v?.recording_enabled, summaries_enabled: !!v?.summaries_enabled });
      }
      if(input.mode === "stop_recording") {
        if(!sid(input.call_sid,"CA")) throw Error("recording_unavailable");
        const account=await one("communication_accounts",{client_id:cid,provider:"twilio",status:"active"});
        if(!account)throw Error("voice_not_ready");
        const provider=await voiceProvider(db,account.provider_account_sid,request);
        const remote=await provider.call(`/Calls/${input.call_sid}.json`);
        const call=await one("client_voice_calls",{client_id:cid,provider_sid:remote.parent_call_sid || remote.sid});
        if(!call || (call.direction==="outbound" && call.actor_id!==uid)) throw Error("forbidden");
        for(const callSid of [call.provider_sid,call.consent_child_sid].filter(Boolean)) {
          const list=await provider.call(`/Calls/${callSid}/Recordings.json`);
          for(const rec of list.recordings || []) if(["in-progress","paused"].includes(rec.status) && sid(rec.sid,"RE"))
            await provider.call(`/Calls/${callSid}/Recordings/${rec.sid}.json`,"POST",{Status:"stopped"});
        }
        return reply(200,{stopped:true});
      }
      if (input.mode === "voice_token") {
        const voice = await one("client_voice_settings", {
          client_id: cid,
          enabled: true,
        });
        const account = await one("communication_accounts", {
          client_id: cid,
          provider: "twilio",
          status: "active",
        });
        if (!voice?.application_sid || !account) throw Error("voice_not_ready");
        const r = await db.rpc("communication_subaccount_secrets", {
          p_account_sid: account.provider_account_sid,
        });
        if (r.error || !r.data?.api_key || !r.data.api_secret)
          throw Error("voice_not_ready");
        return reply(200, {
          token: mint({
            account: account.provider_account_sid,
            key: r.data.api_key,
            secret: r.data.api_secret,
            app: voice.application_sid,
            identity: voiceIdentity(cid, uid),
          }),
        });
      }
      if (!uuid(input.inquiry_id)) throw Error("invalid_inquiry");
      const i = await one(
        "inquiries",
        { id: input.inquiry_id, client_id: cid },
        "id,contact_id,phone_e164",
      );
      if (!i) throw Error("inquiry_not_found");
      if (input.mode === "recording" || input.mode === "transcript") {
        if (!uuid(input.recording_id)) throw Error("recording_unavailable");
        const rec = await one("client_voice_recordings",{id:input.recording_id,client_id:cid});
        const call = rec && await one("client_voice_calls",{id:rec.call_id,client_id:cid,inquiry_id:i.id});
        if (!call || rec.state === "deleted" || Date.parse(rec.expires_at)<=Date.now()) throw Error("recording_unavailable");
        if(input.mode==="transcript") return reply(200,{transcript:rec.transcript});
        const provider = await voiceProvider(db,rec.account_sid,request);
        const audio = await request(`https://api.twilio.com/2010-04-01/Accounts/${rec.account_sid}/Recordings/${rec.recording_sid}.mp3`,{
          headers:{Authorization:provider.authorization}, redirect:"error",signal:AbortSignal.timeout(30000),
        });
        if (!audio.ok) throw Error("recording_unavailable");
        return new Response(audio.body,{headers:{"Content-Type":"audio/mpeg","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
      }
      if (input.mode === "load") return reply(200, await snapshot(cid, i, uid));
      if (input.mode === "save_draft") {
        if (typeof input.body !== "string" || input.body.length > 1600)
          throw Error("invalid_draft");
        await check(
          db.from("client_phone_drafts").upsert(
            {
              client_id: cid,
              inquiry_id: i.id,
              actor_id: uid,
              body: input.body,
              revision: crypto.randomUUID(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "client_id,inquiry_id,actor_id" },
          ),
        );
        return reply(200, await snapshot(cid, i, uid));
      }
      if (input.mode === "prepare_call") {
        const voice = await one("client_voice_settings", {
          client_id: cid,
          enabled: true,
        });
        const number = await one("communication_numbers", {
          client_id: cid,
          is_primary: true,
          status: "active",
        });
        if (!voice?.application_sid || !number?.voice_enabled)
          throw Error("voice_not_ready");
        // The lead, not the setup: say so (it used to read "Calling setup is not complete").
        if (!E164.test(i.phone_e164 || "")) throw Error("no_lead_phone");
        const recent = await check(
          db
            .from("client_voice_calls")
            .select("id")
            .eq("client_id", cid)
            .eq("actor_id", uid)
            .gte("created_at", new Date(Date.now() - 60000).toISOString()),
        );
        if (recent.length >= 5) throw Error("rate_limited");
        const id = crypto.randomUUID();
        await check(
          db.from("client_voice_calls").insert({
            id,
            client_id: cid,
            inquiry_id: i.id,
            actor_id: uid,
            direction: "outbound",
            from_number: number.phone_number_e164,
            to_number: i.phone_e164,
            recording_requested: voice.recording_enabled === true,
            recording_consent: voice.recording_enabled ? "pending" : "not_requested",
          }),
        );
        return reply(200, { intent: id });
      }
      if (input.mode === "autosave") {
        // Background draft persistence: never sends, never returns the
        // thread (the composer asks for nothing back).
        if (typeof input.body !== "string" || input.body.length > 1600)
          throw Error("invalid_draft");
        await check(
          db.from("client_phone_drafts").upsert(
            {
              client_id: cid,
              inquiry_id: i.id,
              actor_id: uid,
              body: input.body,
              revision: crypto.randomUUID(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "client_id,inquiry_id,actor_id" },
          ),
        );
        return reply(200, { saved: true });
      }
      if (input.mode === "send") {
        const result = await sendText(cid, i, uid, input);
        return reply(200, { ...(await snapshot(cid, i, uid)), send: result });
      }
      return reply(400, { error: "unknown_mode" });
    } catch (e) {
      const safe = [
        "invalid_settings", "provider_not_ready", "summaries_not_ready", "email_not_ready", "summary_operator_unavailable", "fallback_review_required", "recording_unavailable",
        "forbidden",
        "voice_not_ready",
        "inquiry_not_found",
        "invalid_inquiry",
        "invalid_draft",
        "save_draft_first",
        "send_not_ready",
        "verification_required",
        "send_uncertain_refresh_first",
        "no_consent",
        "opted_out",
        "outbound_disabled",
        "rate_limited",
        "no_lead_phone",
        "invalid_request",
        ...SMS_REFUSALS,
      ];
      const code =
        e instanceof Error && safe.includes(e.message)
          ? e.message
          : "request_failed";
      return reply(code === "forbidden" ? 403 : 409, { error: code });
    }
  };
}
