import { address, uuid } from "../client-mailbox/mail.ts";
import type { DB } from "../client-mailbox/handler.ts";
// Signature verification is injected for tests; production uses the official Svix SDK.
export function createEmailWebhook(
  db: DB,
  verify: (
    raw: string,
    headers: Record<string, string>,
    secret: string,
  ) => unknown,
  request: typeof fetch = fetch,
) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    if (Number(req.headers.get("content-length")) > 100000)
      return new Response("Too large", { status: 413 });
    const raw = await req.text();
    if (raw.length > 100000) return new Response("Too large", { status: 413 });
    const secret = await db.rpc("get_secret", {
      secret_name: "CLIENT_RESEND_WEBHOOK_SECRET",
    });
    if (secret.error || !secret.data)
      return new Response("Unavailable", { status: 503 });
    let event: DB;
    try {
      verify(raw, Object.fromEntries(req.headers.entries()), secret.data);
      event = JSON.parse(raw);
    } catch {
      return new Response("Invalid signature", { status: 403 });
    }
    const data = event?.data,
      eventId = req.headers.get("svix-id");
    if (
      !eventId ||
      !data ||
      !uuid(data.email_id) ||
      !Number.isFinite(Date.parse(event.created_at))
    )
      return new Response("Invalid event", { status: 400 });
    try {
      const p: Record<string, unknown> = {
        event_id: eventId,
        type: event.type,
        provider_id: data.email_id,
        at: event.created_at,
      };
      if (event.type === "email.received") {
        // Address tokens route only existing lead conversations. Email text is
        // displayed as text, never executed, rendered as HTML, or sent to an agent.
        const recipients = (Array.isArray(data.to) ? data.to : [])
          .map(address)
          .filter(Boolean);
        const matches = recipients
          .map((to: string) => ({
            to,
            match: /^r\.([a-f0-9-]{36})@([a-z0-9.-]+)$/.exec(to),
          }))
          .filter((x: DB) => x.match && uuid(x.match[1]));
        if (matches.length !== 1)
          return new Response("Ignored", { status: 200 });
        const { to, match } = matches[0];
        const t = await db
          .from("client_email_threads")
          .select("client_id,recipient")
          .eq("reply_token", match[1])
          .maybeSingle();
        if (t.error) throw Error("database");
        if (!t.data || t.data.recipient !== address(data.from))
          return new Response("Ignored", { status: 200 });
        const b = await db
          .from("client_mailboxes")
          .select("enabled,provider,reply_domain,api_key_secret")
          .eq("client_id", t.data.client_id)
          .maybeSingle();
        if (b.error) throw Error("database");
        if (
          !b.data?.enabled ||
          b.data.provider !== "resend" ||
          b.data.reply_domain !== match[2]
        )
          return new Response("Ignored", { status: 200 });
        const key = await db.rpc("get_secret", {
          secret_name: "CLIENT_RESEND_RECEIVING_API_KEY",
        });
        if (key.error || !key.data) throw Error("configuration");
        const r = await request(
          "https://api.resend.com/emails/receiving/" + data.email_id,
          {
            headers: { Authorization: "Bearer " + key.data },
            signal: AbortSignal.timeout(20000),
            redirect: "error",
          },
        );
        if (!r.ok) throw Error("provider");
        const mail = await r.json();
        if (
          mail.id !== data.email_id ||
          address(mail.from) !== t.data.recipient ||
          !(mail.to || []).map(address).includes(to)
        )
          return new Response("Ignored", { status: 200 });
        Object.assign(p, {
          reply_token: match[1],
          sender: t.data.recipient,
          recipient: to,
          rfc_id:
            mail.message_id ||
            `<received-${data.email_id}@${b.data.reply_domain}>`,
          subject: String(mail.subject || "Reply"),
          body:
            typeof mail.text === "string"
              ? mail.text
              : "[This email contains formatted content or attachments only. Contact Compass to retrieve it.]",
        });
      } else {
        const delivery: Record<string, string> = {
          "email.sent": "sent",
          "email.delivered": "delivered",
          "email.delivery_delayed": "delayed",
          "email.bounced": "bounced",
          "email.complained": "complained",
          "email.failed": "failed",
          "email.suppressed": "suppressed",
        };
        const id = Array.isArray(data.tags)
          ? data.tags.find((t: DB) => t.name === "crm_message_id")?.value
          : data.tags?.crm_message_id;
        if (!delivery[event.type] || !uuid(id) || data.to?.length !== 1)
          return new Response("Ignored", { status: 200 });
        Object.assign(p, {
          message_id: id,
          sender: address(data.from),
          recipient: address(data.to[0]),
          delivery: delivery[event.type],
        });
      }
      const saved = await db.rpc("client_email_record_event", { p });
      if (saved.error) throw Error("database");
      return new Response("OK", { status: 200 });
    } catch {
      return new Response("Retry later", { status: 503 });
    }
  };
}
