import { loginErrorMessage } from "@/lib/password-recovery";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return <LoginForm notice={loginErrorMessage(typeof error === "string" ? error : null)} />;
}
