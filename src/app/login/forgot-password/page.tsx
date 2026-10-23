import { forgotPasswordErrorMessage } from "@/lib/password-recovery";
import { ForgotPasswordForm } from "./forgot-password-form";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string | string[]; error?: string | string[] }>;
}) {
  const { email, error } = await searchParams;
  return (
    <ForgotPasswordForm
      initialEmail={typeof email === "string" ? email : ""}
      notice={forgotPasswordErrorMessage(typeof error === "string" ? error : null)}
    />
  );
}
