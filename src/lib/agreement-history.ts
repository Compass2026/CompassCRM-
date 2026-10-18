import type { Contract } from "./agreements";
type AgreementEvent = NonNullable<Contract["events"]>[number];

export function agreementEventDisplay(event: AgreementEvent) {
  const defaults = { title: event.kind.replaceAll("_", " "), detail: "", warning: false };
  switch (event.kind) {
    case "verification_requested":
      return { ...defaults, detail: "A code was requested. This entry alone does not confirm an email was sent." };
    case "verification_email_accepted":
      return { title: "Verification email accepted", detail: "The email provider accepted the code for sending. Inbox delivery and verification are not yet confirmed.", warning: false };
    case "verification_email_failed":
      return { title: "Verification email failed", detail: event.detail.failure_code === "sender_not_authorized"
        ? "The email provider rejected the sender configuration. The code was not sent. Compass must correct the email setup before another attempt."
        : "The email provider rejected the verification email. The code was not sent. Contact Compass for help.", warning: true };
    case "verification_email_unknown":
      return { title: "Verification email outcome unknown", detail: "Sending could not be confirmed. Check delivery records before requesting another code.", warning: true };
    default:
      return defaults;
  }
}
