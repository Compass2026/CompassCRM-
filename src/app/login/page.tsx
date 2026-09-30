import { loginErrorMessage } from "@/lib/password-recovery";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return <LoginForm initialError={loginErrorMessage(error)} />;
}
