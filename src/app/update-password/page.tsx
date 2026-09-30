import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RESET_TOKEN_COOKIE, isRecoveryTokenHash } from "@/lib/password-recovery";
import { UpdatePasswordForm } from "./update-password-form";

// Opens only from a password-reset link: /auth/confirm leaves the link's
// unspent token in an httpOnly cookie scoped to this path, and the form's
// action spends it. Without one, being signed in is not enough (a laptop left
// open) — a signed-in visitor goes home and anyone else to /login. The proxy
// lets signed-out visitors through, since a reset link is often opened in a
// browser that is not signed in.
export default async function UpdatePasswordPage() {
  const cookieStore = await cookies();
  if (!isRecoveryTokenHash(cookieStore.get(RESET_TOKEN_COOKIE)?.value)) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    redirect(user ? "/" : "/login");
  }
  return <UpdatePasswordForm />;
}
