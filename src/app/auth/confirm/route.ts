import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_MAX_AGE,
  UPDATE_PASSWORD_PATH,
  safeNextPath,
} from "@/lib/password-recovery";

// Handles both Supabase auth callback styles:
// - PKCE flow (default email templates): ?code=...
// - token-hash links (customized templates): ?token_hash=...&type=...
// A password-reset link carries next=/update-password; a token-hash recovery
// link goes there whatever next says. next is only ever a same-site path.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next =
    type === "recovery"
      ? UPDATE_PASSWORD_PATH
      : safeNextPath(searchParams.get("next"));

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return verified(next, request);
  }

  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return verified(next, request);
  }

  return NextResponse.redirect(new URL("/login?error=invalid_link", request.url));
}

function verified(next: string, request: NextRequest) {
  const response = NextResponse.redirect(new URL(next, request.url));
  if (next === UPDATE_PASSWORD_PATH) {
    response.cookies.set(RECOVERY_COOKIE, "1", {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: UPDATE_PASSWORD_PATH,
      maxAge: RECOVERY_COOKIE_MAX_AGE,
    });
  }
  return response;
}
