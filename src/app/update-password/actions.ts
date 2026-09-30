"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  RECOVERY_COOKIE,
  UPDATE_PASSWORD_PATH,
  newPasswordProblem,
} from "@/lib/password-recovery";

export type UpdatePasswordState = { error: string } | null;

export async function updatePasswordAction(
  _prev: UpdatePasswordState,
  formData: FormData,
): Promise<UpdatePasswordState> {
  const cookieStore = await cookies();
  if (cookieStore.get(RECOVERY_COOKIE)?.value !== "1") {
    return {
      error:
        "This reset has expired. Sign out and request a new link from the sign-in page.",
    };
  }

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const problem = newPasswordProblem(password, confirm);
  if (problem) return { error: problem };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=invalid_link");

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };

  // A reset often means the old password leaked: end every other session.
  // Best-effort; the new password is already saved.
  await supabase.auth.signOut({ scope: "others" });
  cookieStore.delete({ name: RECOVERY_COOKIE, path: UPDATE_PASSWORD_PATH });
  redirect("/");
}
