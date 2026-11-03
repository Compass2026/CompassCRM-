import { voiceIdentity } from "./identity.ts";
import { uuid } from "../client-mailbox/mail.ts";
import type { DB } from "../client-mailbox/handler.ts";
import { createTwilioProvider } from "../_shared/communications/twilio.ts";
import { ProviderError } from "../_shared/communications/provider.ts";
import { voiceAdmin } from "./voice-admin.ts";
import { voiceProvider, sid } from "./voice-provider.ts";
const reply = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
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
        i.phone_e164
          ? check(
              db
                .from("communication_consents")
                .select("status,consent_type")
                .eq("client_id", cid)
                .eq("phone_e164", i.phone_e164),
            )
          : [],
        i.contact_id
          ? check(
              db
                .from("communication_conversations")
                .select("id")
                .eq("client_id", cid)
                .eq("contact_id", i.contact_id),
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
          : !i.phone_e164
            ? "This lead has no valid phone number."
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
      can_send: !reason,
      reason,
      voice_ready: !!(voice?.enabled && voice.application_sid && number),
    };
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
        if (
          !voice?.application_sid ||
          !number?.voice_enabled ||
          !/^\+[1-9][0-9]{7,14}$/.test(i.phone_e164 || "")
        )
          throw Error("voice_not_ready");
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
      if (input.mode === "send") {
        if (!uuid(input.revision)) throw Error("save_draft_first");
        const begun = await db.rpc("client_phone_begin_sms", {
          p: {
            client_id: cid,
            inquiry_id: i.id,
            actor_id: uid,
            request_id: input.revision,
          },
        });
        if (begun.error)
          throw Error(
            [
              "verification_required",
              "save_draft_first",
              "send_uncertain_refresh_first",
              "no_consent",
              "opted_out",
              "outbound_disabled",
            ].find((v) => begun.error.message.includes(v)) || "send_not_ready",
          );
        const b = begun.data;
        if (!b.duplicate) {
          const secrets = await db.rpc("communication_subaccount_secrets", {
            p_account_sid: b.account_sid,
          });
          if (
            secrets.error ||
            !secrets.data?.api_key ||
            !secrets.data.api_secret
          )
            throw Error("send_uncertain_refresh_first");
          const provider = createTwilioProvider(request);
          try {
            const s = await provider.sendMessage(
              {
                scope: "subaccount",
                accountSid: b.account_sid,
                keySid: secrets.data.api_key,
                keySecret: secrets.data.api_secret,
              },
              {
                messagingServiceSid: b.messaging_service_sid,
                to: b.to,
                body: b.body,
                statusCallbackUrl:
                  base +
                  "/functions/v1/twilio-webhook/messages/status?m=" +
                  b.message_id,
              },
            );
            await check(
              db.rpc("communication_mark_sent", {
                p: {
                  message_id: b.message_id,
                  provider_message_sid: s.sid,
                  provider_status: s.status,
                  error_code: s.errorCode,
                  error_message: s.errorMessage,
                },
              }),
            );
            await check(
              db
                .from("client_phone_drafts")
                .delete()
                .eq("client_id", cid)
                .eq("inquiry_id", i.id)
                .eq("actor_id", uid)
                .eq("revision", input.revision),
            );
          } catch (e) {
            if (e instanceof ProviderError && e.status >= 400 && e.status < 500)
              await check(
                db.rpc("communication_mark_sent", {
                  p: {
                    message_id: b.message_id,
                    error_code: e.code || String(e.status),
                    error_message: e.message,
                  },
                }),
              );
            else throw Error("send_uncertain_refresh_first");
          }
        }
        return reply(200, await snapshot(cid, i, uid));
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
      ];
      const code =
        e instanceof Error && safe.includes(e.message)
          ? e.message
          : "request_failed";
      return reply(code === "forbidden" ? 403 : 409, { error: code });
    }
  };
}
