// Stripe webhook signature verification (the scheme Stripe documents for
// its `Stripe-Signature` header): HMAC-SHA256 of `${timestamp}.${raw body}`
// with the endpoint's signing secret, compared against every v1 signature
// in the header, with a timestamp tolerance against replays. WebCrypto only,
// so it runs in Deno and Node alike.

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function stripeSignature(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`)));
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): Promise<SignatureCheck> {
  if (!header) return { ok: false, reason: "missing" };
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v);
  if (!Number.isFinite(t) || sigs.length === 0) return { ok: false, reason: "malformed" };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return { ok: false, reason: "expired" };
  const expected = await stripeSignature(secret, t, payload);
  return sigs.some((s) => equal(s, expected)) ? { ok: true } : { ok: false, reason: "mismatch" };
}
