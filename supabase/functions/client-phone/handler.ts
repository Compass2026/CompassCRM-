import { uuid } from "../client-mailbox/mail.ts";
import type { DB } from "../client-mailbox/handler.ts";
import { createTwilioProvider } from "../_shared/communications/twilio.ts";
import { ProviderError } from "../_shared/communications/provider.ts";
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
    return {
      draft,
      messages: messages.reverse(),
      calls,
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
            identity: `crm_${cid}_${uid}`,
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
      if (input.mode === "load") return reply(200, await snapshot(cid, i, uid));
      if (input.mode === "save_draft") {
        if (typeof input.body !== "string" || input.body.length > 1600)
          throw Error("invalid_draft");
        await check(
          db
            .from("client_phone_drafts")
            .upsert(
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
          db
            .from("client_voice_calls")
            .insert({
              id,
              client_id: cid,
              inquiry_id: i.id,
              actor_id: uid,
              direction: "outbound",
              from_number: number.phone_number_e164,
              to_number: i.phone_e164,
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
