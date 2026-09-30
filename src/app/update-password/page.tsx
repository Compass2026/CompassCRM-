import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RECOVERY_COOKIE } from "@/lib/password-recovery";
import { UpdatePasswordForm } from "./update-password-form";

// Reached only from a password-reset link: /auth/confirm exchanges it for a
// session and sets the short-lived recovery cookie. The proxy already sends a
// signed-out visitor to /login; a signed-in one without the cookie (a laptop
// left open) goes home instead of getting to set a password.
export default async function UpdatePasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=invalid_link");

  const cookieStore = await cookies();
  if (cookieStore.get(RECOVERY_COOKIE)?.value !== "1") redirect("/");

  return <UpdatePasswordForm email={user.email ?? ""} />;
}
