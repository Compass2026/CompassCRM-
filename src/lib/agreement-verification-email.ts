// No credentials, codes, link tokens or raw provider errors enter the audit trail.
export type VerificationDelivery = {
  outcome: "accepted" | "failed" | "unknown";
  provider_id?: string;
  http_status?: number;
  failure_code?: "sender_not_authorized" | "provider_rejected" | "rate_limited" | "provider_unavailable" | "transport_unknown";
};

export async function deliverVerificationEmail(
  email: { from: string; to: string; issuer: string; code: string },
  apiKey: string,
  record: (outcome: VerificationDelivery) => Promise<void>,
  send: typeof fetch = fetch,
) {
  let outcome: VerificationDelivery;
  try {
    const response = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        subject: `${email.issuer}: agreement verification code`,
        text: `Your agreement verification code is ${email.code}. It expires in 10 minutes.\n\nOnly use this code if you requested it. Do not share it with anyone.`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const body = await response.json();
      outcome = typeof body?.id === "string" && /^[A-Za-z0-9-]{1,100}$/.test(body.id)
        ? { outcome: "accepted", provider_id: body.id, http_status: response.status }
        : { outcome: "unknown", failure_code: "transport_unknown", http_status: response.status };
    } else {
      outcome = {
        outcome: response.status >= 500 ? "unknown" : "failed",
        http_status: response.status,
        failure_code: response.status === 401 || response.status === 403
          ? "sender_not_authorized"
          : response.status === 429 ? "rate_limited"
          : response.status >= 500 ? "provider_unavailable" : "provider_rejected",
      };
    }
  } catch {
    outcome = { outcome: "unknown", failure_code: "transport_unknown" };
  }
  // Keep audit errors out of the send catch: never turn a successful send into
  // a second send or a false provider failure if storage is unavailable.
  try {
    await record(outcome);
  } catch {
    console.error("agreement_verification_delivery_audit_failed");
    throw new Error("The verification email status could not be saved. Check your inbox before requesting another code, or contact the sender.");
  }
  if (outcome.outcome === "unknown")
    throw new Error("The verification email status could not be confirmed. Check your inbox before requesting another code, or contact the sender.");
  if (outcome.outcome === "failed")
    throw new Error(outcome.failure_code === "sender_not_authorized"
      ? "The verification email could not be sent because of a sender configuration problem. Please contact Compass for help."
      : "The verification email could not be sent. Wait one minute and try again or contact the sender.");
  return { ok: true };
}
