import "server-only";
import { Pool } from "pg";
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Contract } from "./agreements";
import { buildAgreementPdf } from "./agreement-pdf";

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
  const answer = await agreementSigner<{
    email?: string;
    issuer?: string;
    error?: string;
  }>(token, undefined, "code", { code_hash: sha256(`${token}:${code}`) });
  if (answer.error || !answer.email) return answer;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AGREEMENTS_RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.AGREEMENTS_EMAIL_FROM,
      to: [answer.email],
      subject: `${answer.issuer}: agreement verification code`,
      text: `Your agreement verification code is ${code}. It expires in 10 minutes.\n\nOnly use this code if you requested it. Do not share it with anyone.`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok)
    throw new Error(
      "The verification email could not be sent. Wait one minute and try again or contact the sender.",
    );
  return { ok: true };
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
