// twilio-webhook (Compass Communications, 0063): Twilio's inbound SMS and
// delivery-status callbacks for every client subaccount.
//
//   POST …/twilio-webhook/messages/inbound   a Messaging Service's inbound URL
//   POST …/twilio-webhook/messages/status    a message's StatusCallback
//                                           (?m=<Compass message id>)
//
// Deployed with verify_jwt = false: Twilio sends no Supabase JWT. Every
// request is authenticated by its X-Twilio-Signature, validated with the
// official SDK (injected as `validate`) against the Auth Token of the
// subaccount named by AccountSid (Vault, TWILIO_SUB_<sid>_AUTH_TOKEN) and the
// public URL Twilio called. An unknown account, a missing token or a bad
// signature is 403 and nothing is read or written.
//
// Retry-safe: an inbound MessageSid is recorded once (a retry answers the
// same 200); a status only moves forward. Parameters Twilio adds later are
// ignored. The answer to an inbound message is an empty <Response/>: Compass
// never sends an automatic reply, and STOP / HELP replies are Twilio's.
//
// Logs carry SIDs and outcome codes only — never a body, a phone number's
// message, a token or the signature.
import { INBOUND_PATH, STATUS_PATH, ACCOUNT_SID, MESSAGE_SID } from "../_shared/communications/credentials.ts";
import { optOutFromTwilio, optOutKeyword } from "../../../src/lib/communications.ts";

export const HANDLER_VERSION = 2;

export type Validator = (authToken: string, signature: string, url: string, params: Record<string, string>) => boolean;

export type Store = {
  // The subaccount's Auth Token from Vault (TWILIO_SUB_<sid>_AUTH_TOKEN), or null.
  authToken(accountSid: string): Promise<string | null>;
  accountKnown(accountSid: string): Promise<boolean>;
  recordInbound(p: Record<string, unknown>): Promise<Record<string, unknown>>;
  recordStatus(p: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export type Log = (event: string, detail: Record<string, unknown>) => void;

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const twiml = (status = 200) => new Response(EMPTY_TWIML, { status, headers: { "Content-Type": "text/xml" } });
const text = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/plain" } });

// "code: message" from the database.
const codeOf = (e: unknown) => ((e instanceof Error ? e.message : String(e)).match(/^([a-z_]+):/) ?? [])[1] ?? "error";

export function createTwilioWebhook(deps: { store: Store; validate: Validator; publicBase: () => Promise<string>; log?: Log }) {
  const { store, validate } = deps;
  const log: Log = deps.log ?? (() => {});

  async function handle(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (e) {
      log("error", { code: codeOf(e) });
      return text(500, "error");
    }
  }

  async function route(req: Request): Promise<Response> {
    if (req.method !== "POST") return text(405, "POST only");
    const url = new URL(req.url);
    // The function sees /twilio-webhook/<route> (or /functions/v1/… behind
    // some proxies); the route is what follows the function's name.
    const at = url.pathname.indexOf("/twilio-webhook");
    const route = at >= 0 ? url.pathname.slice(at + "/twilio-webhook".length) : url.pathname;
    if (route !== INBOUND_PATH && route !== STATUS_PATH) return text(404, "not found");

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) return text(415, "form posts only");
    const raw = await req.text();
    // Every parameter Twilio sent is part of the signature, known or not.
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

    const signature = req.headers.get("x-twilio-signature") ?? "";
    const accountSid = params.AccountSid ?? "";
    if (!signature || !ACCOUNT_SID.test(accountSid)) {
      log("rejected", { route, reason: "unsigned_or_no_account" });
      return text(403, "forbidden");
    }
    if (!(await store.accountKnown(accountSid))) {
      log("rejected", { route, reason: "unknown_account", account: accountSid });
      return text(403, "forbidden");
    }
    const token = await store.authToken(accountSid);
    if (!token) {
      log("rejected", { route, reason: "no_auth_token_in_vault", account: accountSid });
      return text(403, "forbidden");
    }
    const publicUrl = (await deps.publicBase()) + route + url.search;
    if (!validate(token, signature, publicUrl, params)) {
      log("rejected", { route, reason: "bad_signature", account: accountSid });
      return text(403, "forbidden");
    }

    const messageSid = params.MessageSid ?? params.SmsMessageSid ?? params.SmsSid ?? "";
    if (!MESSAGE_SID.test(messageSid)) {
      log("ignored", { route, reason: "no_message_sid", account: accountSid });
      return route === INBOUND_PATH ? twiml() : text(200, "");
    }

    if (route === INBOUND_PATH) {
      const fromTwilio = optOutFromTwilio(params.OptOutType);
      const keyword = fromTwilio ? null : optOutKeyword(params.Body);
      try {
        const r = await store.recordInbound({
          message_sid: messageSid,
          account_sid: accountSid,
          to: params.To,
          from: params.From,
          body: params.Body ?? "",
          num_media: params.NumMedia ?? "0",
          opt_out_type: fromTwilio ?? keyword,
          opt_out_via: fromTwilio ? "twilio" : keyword ? "keyword" : null,
        });
        log("inbound", { message: messageSid, account: accountSid, duplicate: r.duplicate === true, opt_out: fromTwilio ?? keyword });
        return twiml();
      } catch (e) {
        const code = codeOf(e);
        log("inbound_failed", { message: messageSid, account: accountSid, code });
        // A number not (yet) linked in Compass: tell Twilio it is not ours, so
        // it shows in Twilio's debugger. Anything else is ours to retry.
        if (code === "unknown_number") return text(404, "number not linked in Compass");
        if (code === "invalid") return text(400, "invalid message");
        return text(500, "error");
      }
    }

    // Status callback. The Compass message id rides in the URL we gave Twilio.
    const status = (params.MessageStatus ?? params.SmsStatus ?? "").toLowerCase();
    try {
      const r = await store.recordStatus({
        message_sid: messageSid,
        message_id: url.searchParams.get("m"),
        account_sid: accountSid,
        status,
        error_code: params.ErrorCode ?? null,
        error_message: params.ErrorMessage ?? null,
      });
      log("status", { message: messageSid, account: accountSid, status, result: r.result });
      return text(200, "");
    } catch (e) {
      const code = codeOf(e);
      log("status_failed", { message: messageSid, account: accountSid, status, code });
      if (code === "invalid") return text(200, ""); // a status Compass does not track; nothing to retry
      if (code === "forbidden") return text(403, "forbidden");
      return text(500, "error");
    }
  }

  return { handle, version: HANDLER_VERSION };
}
