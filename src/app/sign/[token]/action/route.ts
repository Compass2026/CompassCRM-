import { cookies } from "next/headers";
import { agreementErrors, type Contract } from "@/lib/agreements";
import { buildAgreementPdf } from "@/lib/agreement-pdf";
import {
  agreementOrigin,
  agreementSigner,
  newAgreementToken,
  sealedAgreementPdf,
  sendVerificationCode,
  sha256,
  validAgreementToken,
} from "@/lib/agreements-server";
export const runtime = "nodejs";
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  if (request.headers.get("origin") !== agreementOrigin())
    return json({ error: "Request origin refused." }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Invalid request." }, 415);
  const { token } = await params;
  if (!validAgreementToken(token))
    return json({ error: agreementErrors.unavailable }, 404);
  try {
    if (Number(request.headers.get("content-length")) > 5000)
      return json({ error: "Request too large." }, 413);
    const text = await request.text();
    if (text.length > 5000) return json({ error: "Request too large." }, 413);
    const body = JSON.parse(text);
    const cookieStore = await cookies();
    const session = cookieStore.get("agreement_session")?.value;
    let answer: { error?: string; ok?: boolean };
    if (body.action === "code") answer = await sendVerificationCode(token);
    else if (body.action === "verify") {
      if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code))
        return json({ error: "Enter the six-digit code." }, 400);
      const nonce = newAgreementToken();
      answer = await agreementSigner(token, undefined, "verify", {
        code_hash: sha256(`${token}:${body.code}`),
        session_hash: sha256(nonce),
      });
      if (answer.ok)
        cookieStore.set("agreement_session", nonce, {
          httpOnly: true,
          secure: agreementOrigin().startsWith("https:"),
          sameSite: "strict",
          path: `/sign/${token}`,
          maxAge: 3600,
        });
    } else if (body.action === "sign" || body.action === "decline") {
      if (
        body.action === "sign" &&
        (body.consent !== true ||
          typeof body.name !== "string" ||
          body.name.trim().length < 2 ||
          body.name.length > 160)
      )
        return json({ error: agreementErrors.consent_required }, 400);
      if (body.action === "sign") {
        const current = await agreementSigner<
          Contract & { verified?: boolean }
        >(token, session, "read");
        if (!current.verified)
          return json({ error: agreementErrors.verification_required }, 403);
        try {
          await buildAgreementPdf({
            ...current,
            signer_name: body.name.trim(),
          });
        } catch {
          return json(
            {
              error:
                "Your signature contains a character we cannot render in the signed PDF. Contact the sender for assistance.",
            },
            400,
          );
        }
      }
      const signed = await agreementSigner<Contract & { error?: string }>(
        token,
        session,
        body.action,
        {
          name: typeof body.name === "string" ? body.name.trim() : null,
          consent: body.consent === true,
          content_hash: body.content_hash,
          // Vercel supplies this header. It is observed context, not identity proof.
          ip:
            request.headers.get("x-vercel-forwarded-for")?.split(",")[0] ??
            null,
          agent: request.headers.get("user-agent"),
        },
      );
      answer = signed;
      if (signed.status === "signed") {
        try {
          await sealedAgreementPdf(signed, { token, session });
        } catch {
          return json({
            notice:
              "Your signature is saved. Your signed PDF will be available when you download it.",
          });
        }
      }
    } else return json({ error: "Invalid agreement action." }, 400);
    if (answer.error)
      return json(
        { error: agreementErrors[answer.error] ?? agreementErrors.unavailable },
        400,
      );
    return json({
      ok: true,
      notice:
        body.action === "sign"
          ? "Agreement signed and saved."
          : body.action === "decline"
            ? "Agreement declined."
            : "Email verified.",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    return json(
      {
        error:
          message.startsWith("Email verification") ||
          message.startsWith("The verification email")
            ? message
            : "Agreement service is temporarily unavailable. Please try again shortly.",
      },
      503,
    );
  }
}
