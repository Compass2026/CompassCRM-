"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamRole } from "@/lib/team";
import {
  agreementStaff,
  agreementMailReady,
  agreementOrigin,
  newAgreementToken,
  sha256,
  validAgreementToken,
  prepareContractPayment,
  checkAgreementEmailSetup,
} from "@/lib/agreements-server";
import type { Contract } from "@/lib/agreements";
import { buildAgreementPdf } from "@/lib/agreement-pdf";
import { buildAgreementEmail } from "@/lib/agreement-email";

const field = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const base = (id: string) => `/clients/${id}/agreements`;
async function admin() {
  const supabase = await createClient();
  const me = await getCurrentTeamRole(supabase);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || me?.role !== "admin")
    throw new Error("Only a Compass admin can issue or change agreements.");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in again to prepare secure payment.");
  return { supabase, actor: user.id, jwt: session.access_token };
}
function friendly(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Agreement could not be saved.";
  const known: Record<string, string> = {
    agreement_terms_required: "Add the complete contract terms first.",
    agreement_terms_and_recipient_required:
      "Save the contract terms and recipient first.",
    agreement_recipient_required:
      "Enter the recipient’s full name and valid email.",
    agreement_review_required:
      "Review the agreement and type your name to sign for Compass.",
    agreement_plan_changed_save_again:
      "The plan changed. Save and review the draft again.",
    agreement_draft_only:
      "Only a draft can be edited or issued. Create a new agreement for changes.",
    agreement_live_signed_only:
      "A signed agreement and live billing are required. Billing is currently in test mode.",
    agreement_live_issued_required:
      "An issued or signed agreement and live billing are required to prepare payment.",
    agreement_payment_link_required:
      "Prepare a current payment link for this agreement before sending it.",
    agreement_signed_scope_changed:
      "The current plan differs from the signed agreement. Review an amendment before requesting payment.",
    agreement_live_checkout_required:
      "Create a live payment link in Billing, then attach it here.",
    agreement_plan_required: "Record the client’s plan first.",
    "Agreement contains a character the PDF font cannot render.":
      "The agreement contains a character the PDF font cannot render. Review the draft text before issuing.",
  };
  return (
    known[message] ??
    (message.includes("configured") || message.startsWith("Only a Compass") || message.startsWith("Payment setup could not")
      ? message
      : "The agreement action could not be completed. Try again or check the client’s plan.")
  );
}
function back(clientId: string, message?: string): never {
  revalidatePath(base(clientId));
  redirect(
    `${base(clientId)}${message ? `?error=${encodeURIComponent(message)}` : ""}`,
  );
}
export async function createContractAction(clientId: string) {
  let c: Contract;
  try {
    const { actor } = await admin();
    c = await agreementStaff(actor, "create", { client_id: clientId });
  } catch (e) {
    back(clientId, friendly(e));
  }
  revalidatePath(base(clientId));
  redirect(`${base(clientId)}/${c!.id}`);
}
export async function checkContractEmailSetupAction(clientId: string, id: string) {
  let feedback: { error?: string; notice?: string };
  try {
    const { actor } = await admin();
    const contract = await agreementStaff<Contract>(actor, "read", { id });
    if (contract.client_id !== clientId) throw new Error("Agreement not found.");
    await checkAgreementEmailSetup();
    feedback = { notice: "Email setup test accepted. This checks sending to a test address; it does not confirm delivery to the client." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    feedback = { error: message.startsWith("The verification email") || message.startsWith("Email verification")
      ? message : "Email setup could not be checked. Sign in as a Compass admin and try again." };
  }
  redirect(`${base(clientId)}/${id}?${new URLSearchParams(feedback as Record<string, string>)}`);
}
export async function saveContractAction(
  clientId: string,
  id: string,
  form: FormData,
) {
  let message: string | undefined;
  try {
    const { actor } = await admin();
    await agreementStaff(actor, "save", {
      id,
      client_id: clientId,
      title: field(form, "title"),
      recipient_name: field(form, "recipient_name"),
      recipient_email: field(form, "recipient_email"),
      terms: field(form, "terms"),
    });
  } catch (e) {
    message = friendly(e);
  }
  revalidatePath(base(clientId));
  redirect(
    `${base(clientId)}/${id}?${message ? `error=${encodeURIComponent(message)}` : "notice=Draft%20saved.%20Review%20the%20updated%20scope%20below."}`,
  );
}
export async function saveContractTemplateAction(
  clientId: string,
  form: FormData,
) {
  try {
    const { actor } = await admin();
    await agreementStaff(actor, "template", {
      terms: field(form, "terms"),
      reviewed: form.get("reviewed") === "on",
    });
  } catch (e) {
    back(clientId, friendly(e));
  }
  revalidatePath(base(clientId));
  redirect(
    `${base(clientId)}?notice=Compass%20template%20saved.%20Existing%20agreements%20keep%20their%20own%20terms.`,
  );
}
export type IssueResult = { url?: string; error?: string; notice?: string };
export async function sendContractLinkAction(
  clientId: string,
  id: string,
  token: string,
): Promise<IssueResult> {
  try {
    const { actor, jwt } = await admin();
    if (!validAgreementToken(token) || !agreementMailReady())
      return { error: "Signing email is not available." };
    const c = await agreementStaff<Contract>(actor, "read", { id });
    if (c.client_id !== clientId) return { error: "Agreement not found." };
    const recipient = await agreementStaff<{
      email: string;
      name: string;
      title: string;
      issuer: string;
    }>(actor, "delivery", { id, token_hash: sha256(token) });
    if (c.snapshot.scope.plan.collection === "stripe") await prepareContractPayment(actor, id, jwt);
    const url = `${agreementOrigin()}/sign/${token}`;
    const email = buildAgreementEmail(c, agreementOrigin(), url);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AGREEMENTS_RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `agreement-${id}-${sha256(token)}`,
      },
      body: JSON.stringify({
        from: process.env.AGREEMENTS_EMAIL_FROM,
        to: [recipient.email],
        ...email,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      return {
        error:
          "The email provider did not accept the message. You can copy the signing link instead.",
      };
    const sent = await response.json();
    await agreementStaff(actor, "sent", { id, provider_id: sent.id });
    revalidatePath(base(clientId));
    return {
      notice: `Signing email accepted for delivery to ${recipient.email}.`,
    };
  } catch (e) {
    return { error: friendly(e) };
  }
}
export async function issueContractAction(
  clientId: string,
  id: string,
  _previous: IssueResult,
  form: FormData,
): Promise<IssueResult> {
  try {
    const { actor, jwt } = await admin();
    if (!agreementMailReady())
      return {
        error:
          "Configure agreement verification email before issuing signing links.",
      };
    const current = await agreementStaff<Contract>(actor, "read", { id });
    if (current.client_id !== clientId)
      return { error: "Agreement not found." };
    if (form.get("reviewed") !== "on")
      return {
        error:
          "Confirm you reviewed the complete agreement before signing for Compass.",
      };
    // Validate PDF rendering before anyone signs, including the imported terms.
    await buildAgreementPdf(current);
    const token = newAgreementToken();
    await agreementStaff(
      actor,
      current.status === "issued" ? "relink" : "issue",
      {
        id,
        token_hash: sha256(token),
        reviewed: true,
        provider_name: field(form, "provider_name"),
      },
    );
    if (current.snapshot.scope.plan.collection === "stripe") await prepareContractPayment(actor, id, jwt);
    revalidatePath(base(clientId));
    return {
      url: `${agreementOrigin()}/sign/${token}`,
      notice:
        "Signing link ready. Signing expires 14 days after issue; prepared payment links last seven days. Refresh payment preparation before sending an older agreement.",
    };
  } catch (e) {
    return { error: friendly(e) };
  }
}
export async function voidContractAction(clientId: string, id: string) {
  try {
    const { actor } = await admin();
    const c = await agreementStaff<Contract>(actor, "read", { id });
    if (c.client_id !== clientId) throw new Error("Not found");
    await agreementStaff(actor, "void", { id });
  } catch (e) {
    back(clientId, friendly(e));
  }
  back(clientId);
}
export async function attachContractPaymentAction(
  clientId: string,
  id: string,
) {
  try {
    const { actor, jwt } = await admin();
    const c = await agreementStaff<Contract>(actor, "read", { id });
    if (c.client_id !== clientId) throw new Error("Not found");
    await prepareContractPayment(actor, id, jwt);
  } catch (e) {
    back(clientId, friendly(e));
  }
  revalidatePath(base(clientId));
  redirect(
    `${base(clientId)}/${id}?notice=Payment%20ready.%20After%20signing%2C%20the%20recipient%20can%20continue%20to%20Stripe.%20The%20payment%20link%20is%20valid%20for%20seven%20days%20from%20preparation.`,
  );
}

