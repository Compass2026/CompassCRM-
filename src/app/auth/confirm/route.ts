import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  RESET_TOKEN_COOKIE,
  RESET_TOKEN_COOKIE_MAX_AGE,
  UPDATE_PASSWORD_PATH,
  isRecoveryTokenHash,
  safeNextPath,
  tokenRecordsRecovery,
} from "@/lib/password-recovery";

// Where every emailed auth link lands.
// - Password reset (token-hash template: ?token_hash=…&type=recovery): the
//   token is NOT spent here. It is kept in an httpOnly cookie scoped to
//   /update-password, whose form spends it when the new password is saved
//   (src/lib/password-recovery.ts has the whole flow).
// - Magic link and other sign-in links, both styles:
//   - PKCE flow (default email templates): ?code=...
//   - token-hash links (customized templates): ?token_hash=...&type=...
//   then on to ?next=, which safeNextPath keeps to a same-origin path.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (type === "recovery") {
    if (!isRecoveryTokenHash(token_hash)) return toLogin("invalid_link");
    const response = redirectTo(UPDATE_PASSWORD_PATH);
    response.cookies.set(RESET_TOKEN_COOKIE, token_hash, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: UPDATE_PASSWORD_PATH,
      maxAge: RESET_TOKEN_COOKIE_MAX_AGE,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const next = safeNextPath(searchParams.get("next"));
  const supabase = await createClient();

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // A reset link from the default template signs in as a recovery
      // session without a new password ever being chosen. End it: only the
      // reset form may complete a recovery.
      if (tokenRecordsRecovery(data.session?.access_token)) {
        await supabase.auth.signOut({ scope: "local" });
        return toLogin("reset_unavailable");
      }
      return redirectTo(next);
    }
  }

  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return redirectTo(next);
  }

  return toLogin("invalid_link");
}

// A root-relative Location: the browser resolves it against the origin it
// actually used (production, a preview, or a custom domain), so no redirect
// here depends on how the platform reconstructs request.url, and none can
// name another origin (safeNextPath has already refused "//…").
function redirectTo(path: string) {
  return new NextResponse(null, { status: 307, headers: { Location: path } });
}

function toLogin(error: string) {
  return redirectTo(`/login?error=${error}`);
}
