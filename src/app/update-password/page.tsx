import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UpdatePasswordForm } from "./update-password-form";

// Reached from a password-reset link (/auth/confirm exchanges it for a
// recovery session) or by any signed-in user. The proxy already sends a
// signed-out visitor to /login; this is the page's own check.
export default async function UpdatePasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=invalid_link");

  return <UpdatePasswordForm email={user.email ?? ""} />;
}
