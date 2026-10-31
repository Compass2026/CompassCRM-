import { voiceIdentity } from "../client-phone/identity.ts";
import { uuid } from "../client-mailbox/mail.ts";
import type { DB } from "../client-mailbox/handler.ts";
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const xml = (body: string) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
    { headers: { "Content-Type": "text/xml", "Cache-Control": "no-store" } },
  );
export function createVoiceWebhook(
  db: DB,
  base: string,
  validate: (
    token: string,
    sig: string,
    url: string,
    p: Record<string, string>,
  ) => boolean,
) {
  async function one(t: string, f: Record<string, unknown>, cols = "*") {
    let q = db.from(t).select(cols);
    for (const [k, v] of Object.entries(f)) q = q.eq(k, v);
    const r = await q.maybeSingle();
    if (r.error) throw Error("database");
    return r.data;
  }
  async function active(uid: string, cid: string) {
    const [c, s, m, p] = await Promise.all([
      one("clients", { id: cid }, "status"),
      one("crm_lite_settings", { client_id: cid }, "enabled,portal_enabled"),
      one("team_members", { auth_user_id: uid }, "id"),
      one(
        "portal_users",
        { client_id: cid, auth_user_id: uid, is_active: true },
        "id",
      ),
    ]);
    return (
      c &&
      !["paused", "offboarded"].includes(c.status) &&
      s?.enabled &&
      (m || (s.portal_enabled && p))
    );
  }
  return async (req: Request) => {
    if (req.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const raw = await req.text();
    if (raw.length > 20000) return new Response("Too large", { status: 413 });
    const p = Object.fromEntries(new URLSearchParams(raw)),
      url = new URL(req.url),
      route = url.pathname.split("client-voice-webhook")[1] || "";
    if (
      !["/outbound", "/inbound", "/finished", "/status"].includes(route) ||
      !/^AC[0-9a-fA-F]{32}$/.test(p.AccountSid || "") ||
      !/^CA[0-9a-fA-F]{32}$/.test(p.CallSid || "")
    )
      return new Response("Invalid request", { status: 400 });
    try {
      const account = await one("communication_accounts", {
        provider_account_sid: p.AccountSid,
        provider: "twilio",
        status: "active",
      });
      if (!account) return new Response("Forbidden", { status: 403 });
      const cred = await db.rpc("communication_subaccount_secrets", {
        p_account_sid: p.AccountSid,
      });
      if (
        cred.error ||
        !cred.data?.auth_token ||
        !validate(
          cred.data.auth_token,
          req.headers.get("x-twilio-signature") || "",
          base + route + url.search,
          p,
        )
      )
        return new Response("Forbidden", { status: 403 });
      const cid = account.client_id,
        config = await one("client_voice_settings", {
          client_id: cid,
          enabled: true,
        });
      if (!config)
        return xml("<Say>Calling is currently unavailable.</Say><Hangup/>");
      if (route === "/outbound") {
        if (!uuid(p.Intent)) return xml("<Hangup/>");
        const call = await one("client_voice_calls", {
          id: p.Intent,
          client_id: cid,
          direction: "outbound",
        });
        if (
          !call ||
          p.From !== `client:${voiceIdentity(cid, call.actor_id)}` ||
          !(await active(call.actor_id, cid)) ||
          Date.parse(call.expires_at) < Date.now()
        )
          return xml("<Hangup/>");
        const i = await one(
          "inquiries",
          { id: call.inquiry_id, client_id: cid },
          "phone_e164",
        );
        if (!i || i.phone_e164 !== call.to_number) return xml("<Hangup/>");
        // Claim the one-use destination capability before returning any dial command.
        const claimed = await db
          .from("client_voice_calls")
          .update({
            provider_sid: p.CallSid,
            status: "dialing",
            updated_at: new Date().toISOString(),
          })
          .eq("id", call.id)
          .eq("client_id", cid)
          .eq("status", "prepared")
          .is("provider_sid", null)
          .select("id");
        if (claimed.error) throw Error("database");
        if (claimed.data?.length !== 1) return xml("<Hangup/>");
        return xml(
          `<Dial callerId="${esc(call.from_number)}" timeout="30" action="${esc(base + "/finished")}" method="POST"><Number statusCallback="${esc(base + "/status")}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${esc(call.to_number)}</Number></Dial>`,
        );
      }
      if (route === "/inbound") {
        const n = await one("communication_numbers", {
          client_id: cid,
          phone_number_e164: p.To,
          status: "active",
          voice_enabled: true,
        });
        if (!n) return xml("<Hangup/>");
        const lead = await db
          .from("inquiries")
          .select("id")
          .eq("client_id", cid)
          .eq("phone_e164", p.From)
          .order("received_at", { ascending: false })
          .limit(1);
        if (lead.error) throw Error("database");
        const saved = await db.from("client_voice_calls").upsert(
          {
            client_id: cid,
            inquiry_id: lead.data?.[0]?.id || null,
            provider_sid: p.CallSid,
            direction: "inbound",
            from_number: p.From,
            to_number: p.To,
            status: "ringing",
          },
          { onConflict: "provider_sid", ignoreDuplicates: true },
        );
        if (saved.error) throw Error("database");
        const users = await db
          .from("portal_users")
          .select("auth_user_id")
          .eq("client_id", cid)
          .eq("is_active", true)
          .not("auth_user_id", "is", null)
          .limit(4);
        if (users.error) throw Error("database");
        const enabled = [];
        for (const u of users.data || [])
          if (await active(u.auth_user_id, cid)) enabled.push(u.auth_user_id);
        if (!enabled.length)
          return config.fallback_url
            ? xml(
                `<Redirect method="POST">${esc(config.fallback_url)}</Redirect>`,
              )
            : xml("<Say>Please call again later.</Say><Hangup/>");
        return xml(
          `<Dial timeout="20" action="${esc(base + "/finished")}" method="POST">${enabled.map((u) => `<Client>${esc(voiceIdentity(cid, u))}</Client>`).join("")}</Dial>`,
        );
      }
      const sid = p.ParentCallSid || p.CallSid,
        call = await one("client_voice_calls", {
          client_id: cid,
          provider_sid: sid,
        });
      if (!call) return xml("");
      const state = route === "/finished" ? p.DialCallStatus : p.CallStatus;
      const allowed = [
        "queued",
        "initiated",
        "ringing",
        "in-progress",
        "completed",
        "busy",
        "failed",
        "no-answer",
        "canceled",
      ];
      if (allowed.includes(state)) {
        const terminal = [
          "completed",
          "busy",
          "failed",
          "no-answer",
          "canceled",
        ];
        if (!terminal.includes(call.status)) {
          const changed = await db
            .from("client_voice_calls")
            .update({
              status: state,
              duration: Number(p.DialCallDuration || p.CallDuration) || null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", call.id)
            .eq("client_id", cid)
            .eq("status", call.status);
          if (changed.error) throw Error("database");
        }
      }
      if (
        route === "/finished" &&
        call.direction === "inbound" &&
        state !== "completed" &&
        config.fallback_url
      )
        return xml(
          `<Redirect method="POST">${esc(config.fallback_url)}</Redirect>`,
        );
      return xml(route === "/finished" ? "<Hangup/>" : "");
    } catch {
      return new Response("Retry later", { status: 503 });
    }
  };
}
