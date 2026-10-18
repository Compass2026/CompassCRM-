import "server-only";
import { Pool } from "pg";
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Contract } from "./agreements";
import { buildAgreementPdf } from "./agreement-pdf";
import { paymentLinkCall } from "./payment-links";
import { deliverVerificationEmail } from "./agreement-verification-email";

let pool: Pool | undefined;
function database() {
  if (!process.env.AGREEMENTS_DATABASE_URL)
    throw new Error("Agreement storage is not configured.");
  pool ??= new Pool({
    connectionString: process.env.AGREEMENTS_DATABASE_URL,
    ssl: {
      rejectUnauthorized: true,
      ...(process.env.AGREEMENTS_DATABASE_CA
        ? { ca: process.env.AGREEMENTS_DATABASE_CA }
        : {}),
    },
    max: 3,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  return pool;
}
export const sha256 = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export const newAgreementToken = () => randomBytes(32).toString("base64url");
export const validAgreementToken = (v: string) => /^[A-Za-z0-9_-]{43}$/.test(v);
export async function agreementStaff<T>(
  actor: string,
  action: string,
  args: Record<string, unknown>,
): Promise<T> {
  const r = await database().query(
    "select agreement_private.staff($1::uuid,$2::text,$3::jsonb) as result",
    [actor, action, JSON.stringify(args)],
  );
  return r.rows[0].result as T;
}
export async function agreementSigner<T>(
  token: string,
  session: string | undefined,
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!validAgreementToken(token)) return { error: "unavailable" } as T;
  const r = await database().query(
    "select agreement_private.signer($1::text,$2::text,$3::text,$4::jsonb) as result",
    [
      sha256(token),
      session ? sha256(session) : null,
      action,
      JSON.stringify(args),
    ],
  );
  return r.rows[0].result as T;
}
// Reuse the existing billing delegation. Signing itself never calls Stripe.
export async function prepareContractPayment(actor: string, id: string, jwt: string) {
  const prepare = async (token: string | null) => {
    const result = await database().query(
      "select agreement_private.prepare_payment($1::uuid,$2::uuid,$3::text) as result",
      [actor, id, token],
    );
    return result.rows[0].result as Contract;
  };
  const current = await prepare(null);
  const existing = current.payment_url?.match(/^\/pay\/([A-Za-z0-9_-]{43})$/)?.[1];
  if (existing && current.payment_expires_at && Date.parse(current.payment_expires_at) > Date.now()) {
    const answer = await paymentLinkCall({ action: "read", token: existing });
    if (!answer.error && answer.livemode) return prepare(existing);
  }
  const token = newAgreementToken();
  const answer = await paymentLinkCall({ action: "issue", client_id: current.client_id, token }, jwt);
  if (answer.error || !answer.id || !answer.expires_at)
    throw new Error("Payment setup could not be prepared. Check the client's Billing tab and try again.");
  return prepare(token);
}
export function agreementOrigin(): string {
  const origin =
    process.env.AGREEMENTS_APP_URL ?? "https://compass-crm-ten.vercel.app";
  const u = new URL(origin);
  if (
    u.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(u.hostname)
  )
    throw new Error("Agreement origin must use HTTPS.");
  return u.origin;
}
export const agreementMailReady = () =>
  !!(
    process.env.AGREEMENTS_RESEND_API_KEY && process.env.AGREEMENTS_EMAIL_FROM
  );
export async function sendVerificationCode(token: string) {
  if (!agreementMailReady())
    throw new Error(
      "Email verification is not configured. Contact the sender.",
    );
  const code = randomInt(100000, 1000000).toString();
  const codeHash = sha256(`${token}:${code}`);
  const answer = await agreementSigner<{
    email?: string;
    issuer?: string;
    error?: string;
  }>(token, undefined, "code", { code_hash: codeHash });
  if (answer.error || !answer.email) return answer;
  return deliverVerificationEmail({
    from: process.env.AGREEMENTS_EMAIL_FROM!,
    to: answer.email,
    issuer: answer.issuer ?? "Compass Marketing",
    code,
  }, process.env.AGREEMENTS_RESEND_API_KEY!, async (outcome) => {
    await database().query(
      "select agreement_private.verification_delivery($1::text,$2::text,$3::jsonb)",
      [sha256(token), codeHash, JSON.stringify(outcome)],
    );
  });
}
export async function sealedAgreementPdf(
  c: Contract,
  access: { actor?: string; token?: string; session?: string },
) {
  const args = [
    c.id,
    access.actor ?? null,
    access.token ? sha256(access.token) : null,
    access.session ? sha256(access.session) : null,
  ];
  const query =
    "select agreement_private.artifact($1::uuid,$2::uuid,$3::text,$4::text,$5::bytea) as result";
  let r = await database().query(query, [...args, null]);
  if (!r.rows[0].result.pdf) {
    const bytes = await buildAgreementPdf(c);
    r = await database().query(query, [...args, Buffer.from(bytes)]);
  }
  return Buffer.from(r.rows[0].result.pdf, "base64");
}

