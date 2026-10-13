import { agreementPrice, type Contract } from "./agreements.ts";

export type AgreementEmail = { subject: string; html: string; text: string };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// One renderer for delivery and the staff preview. A null URL makes the
// preview inert: no signing token, verification request, or delivery action.
export function buildAgreementEmail(
  contract: Pick<Contract, "title" | "recipient_name" | "snapshot">,
  origin: string,
  signingUrl: string | null,
): AgreementEmail {
  const base = new URL(origin);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname))
    throw new Error("Agreement origin must use HTTPS.");
  if (signingUrl) {
    const link = new URL(signingUrl);
    if (link.origin !== base.origin || !/^\/sign\/[A-Za-z0-9_-]{43}$/.test(link.pathname) || link.search || link.hash)
      throw new Error("Invalid agreement signing URL.");
  }
  const { scope, issuer_name: issuer } = contract.snapshot;
  const name = contract.recipient_name || "there";
  const price = agreementPrice(scope);
  const term = scope.plan.term_months ? `${scope.plan.term_months} months` : "Month-to-month";
  const subject = `${issuer}: ${contract.title}`;
  const explanation = "Verify your email, review your agreement, and electronically sign when you are ready.";
  const payment = "Signing does not authorize payment. Monthly payment setup is completed separately through Stripe.";
  const buttonStyle = "display:inline-block;background:#f97316;color:#101e36;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;line-height:24px;text-decoration:none;padding:16px 26px;border-radius:8px;border:1px solid #f97316;text-align:center;";
  const button = signingUrl
    ? `<a href="${escapeHtml(signingUrl)}" style="${buttonStyle}">Review &amp; Sign Agreement</a>`
    : `<span style="${buttonStyle}">Review &amp; Sign Agreement</span>`;
  const fallback = signingUrl
    ? `If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(signingUrl)}" style="color:#315b8b;word-break:break-all;overflow-wrap:anywhere;">${escapeHtml(signingUrl)}</a>`
    : "Your recipient's personal signing link will appear here in the sent email.";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="referrer" content="no-referrer"><title>${escapeHtml(subject)}</title>
<style>@media only screen and (max-width:480px){.body-cell{padding:28px 20px!important}.outer-cell{padding:12px 8px!important}.headline{font-size:28px!important;line-height:34px!important}}</style></head>
<body style="margin:0;padding:0;background:#edf2f8;color:#17263d;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your agreement for ${escapeHtml(scope.client_name)} is ready for review and signature.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#edf2f8;"><tr><td class="outer-cell" align="center" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td align="center" style="padding:26px 24px 24px;background:#07162d;border-bottom:4px solid #f97316;">
<img src="${escapeHtml(base.origin)}/compass-agreement-logo.png" width="112" height="112" alt="Compass Marketing Advisors" style="display:block;width:112px;height:112px;border:0;margin:0 auto 12px;">
<p style="margin:0;color:#ffffff;font-size:12px;line-height:20px;letter-spacing:2px;font-weight:700;">COMPASS MARKETING ADVISORS</p></td></tr>
<tr><td class="body-cell" style="padding:36px 40px;">
<p style="margin:0 0 12px;color:#9a430c;font-size:11px;line-height:16px;font-weight:700;letter-spacing:2px;">READY FOR YOUR REVIEW</p>
<h1 class="headline" style="margin:0 0 24px;font-size:32px;line-height:38px;letter-spacing:-0.7px;color:#10213c;">Clear direction.<br>Our next step together.</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:26px;">Hello ${escapeHtml(name)},</p>
<p style="margin:0 0 24px;font-size:16px;line-height:26px;color:#46556b;">Your ${escapeHtml(contract.title)} for <strong style="color:#17263d;">${escapeHtml(scope.client_name)}</strong> is ready. Please take a moment to review the details and sign securely online.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f6fa;border:1px solid #e2e8f0;border-radius:10px;margin:0 0 28px;">
${[["Client", scope.client_name], ["Recurring fee", price], ["Agreement term", term]].map(([label, value]) => `<tr><td style="padding:14px 18px;font-size:12px;line-height:18px;color:#52627a;vertical-align:top;width:36%;">${label}</td><td style="padding:14px 18px 14px 0;font-size:14px;line-height:20px;color:#17263d;font-weight:700;overflow-wrap:anywhere;">${escapeHtml(value)}</td></tr>`).join("")}
</table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="padding:0 0 24px;">${button}</td></tr></table>
<p style="margin:0 0 12px;font-size:14px;line-height:23px;color:#46556b;">${explanation}</p>
<p style="margin:0 0 24px;font-size:13px;line-height:21px;color:#52627a;">${payment}</p>
<p style="margin:0 0 8px;font-size:14px;line-height:23px;color:#46556b;">Need changes or a paper copy? Contact your Compass representative before signing.</p>
<p style="margin:24px 0 0;font-size:14px;line-height:23px;">Thank you for trusting Compass.<br><strong>${escapeHtml(issuer)}</strong></p>
<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e2e8f0;font-size:11px;line-height:18px;color:#64748b;overflow-wrap:anywhere;">${fallback}</p>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
<p style="margin:20px 12px 0;font-size:12px;line-height:20px;color:#52627a;">Clear Direction, Relentless Execution.</p>
</td></tr></table></body></html>`;
  const text = `Hello ${name},\n\nYour ${contract.title} for ${scope.client_name} is ready for review and signature.\n\nClient: ${scope.client_name}\nRecurring fee: ${price}\nAgreement term: ${term}\n\nReview & Sign Agreement:\n${signingUrl ?? "[Personal signing link appears in the sent email]"}\n\n${explanation}\n\n${payment}\n\nNeed changes or a paper copy? Contact your Compass representative before signing.\n\nThank you for trusting Compass.\n${issuer}\n\nClear Direction, Relentless Execution.`;
  return { subject, html, text };
}
