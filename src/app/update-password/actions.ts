"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  FORGOT_PASSWORD_PATH,
  RESET_TOKEN_COOKIE,
  UPDATE_PASSWORD_PATH,
  isRecoveryTokenHash,
  newPasswordProblem,
  resetFailureCode,
} from "@/lib/password-recovery";

export type UpdatePasswordState = { error: string } | null;

// Saves a new password for the account a reset link belongs to. The link's
// token is the only thing that authorises it (src/lib/password-recovery.ts):
// it is spent here, after the password passes our checks and before
// updateUser, and the cookie holding it is deleted whatever happens next.
export async function updatePasswordAction(
  _prev: UpdatePasswordState,
  formData: FormData,
): Promise<UpdatePasswordState> {
  const cookieStore = await cookies();
  const tokenHash = cookieStore.get(RESET_TOKEN_COOKIE)?.value;
  if (!isRecoveryTokenHash(tokenHash)) redirect("/login?error=invalid_link");

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const problem = newPasswordProblem(password, confirm);
  if (problem) return { error: problem };

  cookieStore.delete({ name: RESET_TOKEN_COOKIE, path: UPDATE_PASSWORD_PATH });

  // Spend the token: Supabase Auth checks it is a live recovery token and
  // signs in as its account. Expired, already used or never issued → no.
  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "recovery",
    token_hash: tokenHash,
  });
  if (verifyError) redirect("/login?error=invalid_link");

  // Supabase ends the account's other sessions when the password changes.
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    // The token is spent, so the session it opened must not linger as a
    // way round the form: end it, and send them for a new link.
    await supabase.auth.signOut({ scope: "local" });
    redirect(`${FORGOT_PASSWORD_PATH}?error=${resetFailureCode(error)}`);
  }

  redirect("/");
}
