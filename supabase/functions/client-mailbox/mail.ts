export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];
export const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const email = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 254 &&
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v);
export function b64(v: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(v)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function decode(v: string) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ),
  );
}
export async function digest(v: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function missingScopes(granted: string) {
  const set = new Set(granted.split(/\s+/));
  return SCOPES.filter(
    (s) =>
      s.startsWith("https://www.googleapis.com/auth/gmail.") && !set.has(s),
  );
}
export function returnUrl(
  origin: string,
  allowed: string[],
  client: string,
  portal: boolean,
) {
  const u = new URL(origin);
  if (
    u.protocol !== "https:" ||
    u.origin !== origin ||
    !allowed.includes(origin) ||
    !uuid(client)
  )
    throw new Error("invalid_return_origin");
  return (
    origin +
    (portal ? "/portal/inquiries" : `/clients/${client}/workspace-preview`)
  );
}
export function mime(
  message: {
    sender: string;
    recipient: string;
    subject: string;
    body: string;
    rfc_message_id: string;
  },
  replyId?: string,
) {
  if (
    !email(message.sender) ||
    !email(message.recipient) ||
    /[\r\n]/.test(message.subject) ||
    !/^<[^<>\s]+>$/.test(message.rfc_message_id)
  )
    throw new Error("invalid_message");
  const subject = btoa(
    String.fromCharCode(...new TextEncoder().encode(message.subject)),
  );
  const headers = [
    `From: ${message.sender}`,
    `To: ${message.recipient}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    `Message-ID: ${message.rfc_message_id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  if (replyId) {
    if (!/^<[^<>\s]+>$/.test(replyId)) throw new Error("invalid_reply");
    headers.push(`In-Reply-To: ${replyId}`, `References: ${replyId}`);
  }
  const body =
    btoa(String.fromCharCode(...new TextEncoder().encode(message.body)))
      .match(/.{1,76}/g)
      ?.join("\r\n") || "";
  return b64(headers.join("\r\n") + "\r\n\r\n" + body);
}
export type Part = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
};
export function plainText(p: Part): string {
  if (p.filename || /attachment/i.test(header(p, "Content-Disposition"))) return "";
  if (p.mimeType === "text/plain" && p.body?.data)
    return decode(p.body.data).slice(0, 100000);
  const texts = (p.parts || []).map(plainText).filter(Boolean);
  return texts.join("\n").slice(0, 100000);
}
export function header(p: Part, name: string) {
  return (
    p.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value || ""
  );
}
export function address(s: string) {
  const a = s.match(/<([^<>]+)>/)?.[1] || s.trim();
  return email(a) ? a.toLowerCase() : null;
}
