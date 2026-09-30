// Password recovery (Sept 30 2026): pure rules shared by /auth/confirm, the
// proxy, /login, the forgot-password page and /update-password.
//
// No Next.js imports here, so tests/password-recovery.test.mjs can run it.
//
// The flow, and why it is shaped this way:
//
//   1. /login/forgot-password calls resetPasswordForEmail with
//      redirectTo = <origin>/auth/confirm. The Reset Password email template
//      turns that into <origin>/auth/confirm?token_hash=…&type=recovery
//      (docs/password-recovery.md), so the link works in any browser.
//   2. /auth/confirm does NOT verify a recovery link. It checks the token's
//      shape, stores it in an httpOnly cookie scoped to /update-password and
//      redirects there. Opening the link (or a mail scanner prefetching it)
//      spends nothing.
//   3. /update-password shows the form only while that cookie is present.
//   4. The form's server action validates the new password first, then spends
//      the token (verifyOtp type=recovery), deletes the cookie and calls
//      updateUser({ password }).
//
// So the recovery state is the unspent one-time token itself, checked by
// Supabase Auth when it is spent: a signed-in session is never enough, the
// cookie cannot be forged into a valid token, and it cannot be replayed
// because Supabase refuses a token twice (and clears every outstanding
// token when the password changes).

export const UPDATE_PASSWORD_PATH = "/update-password";
export const FORGOT_PASSWORD_PATH = "/login/forgot-password";
export const AUTH_CONFIRM_PATH = "/auth/confirm";

// Supabase Auth's own minimum is 6; the project may raise it. Ours is 8.
export const MIN_PASSWORD_LENGTH = 8;
// bcrypt reads 72 bytes; Supabase Auth refuses anything longer.
export const MAX_PASSWORD_BYTES = 72;

// The unspent recovery token, set by /auth/confirm, read by /update-password.
export const RESET_TOKEN_COOKIE = "compass_pw_reset";
// A recovery email link lives an hour by default (Auth › Email OTP
// expiration); the cookie never outlives that.
export const RESET_TOKEN_COOKIE_MAX_AGE = 60 * 60;

// A Supabase email token hash: hex (sha224 today), with a "pkce_" prefix when
// the reset was requested by a PKCE client. Anything else is not a token and
// is refused before Supabase sees it.
const TOKEN_HASH = /^(?:pkce_)?[0-9a-f]{40,128}$/;

export function isRecoveryTokenHash(value: string | null | undefined): value is string {
  return typeof value === "string" && TOKEN_HASH.test(value);
}

// ── Redirects ───────────────────────────────────────────────────────────────
// Where /auth/confirm may send someone after it verifies a sign-in link.
// The only redirect target taken from a request anywhere in the auth flow.
//
// Rule: the value must be a same-origin, root-relative path:
//   - at most 2,048 characters;
//   - starts with exactly one "/" (never "//" or "/\");
//   - no backslash, whitespace or control character anywhere;
//   - percent-decodes cleanly, and the decoded value still starts with
//     exactly one "/" and has no backslash or control character ("%20" is
//     fine);
//   - resolved against a placeholder origin it stays on that origin;
//   - is not an auth route (/auth/…, /login…, /update-password), which
//     would loop, sign out, or open the reset form.
// Anything else becomes "/". The return value is rebuilt from the parsed URL
// (path + query + fragment), never the raw input.
const PLACEHOLDER_ORIGIN = "https://compass.invalid";
const UNSAFE_CHAR = /[\\\s\u0000-\u001f\u007f-\u009f]/;
// Once decoded, an encoded space ("%20") is a legitimate path character.
const UNSAFE_DECODED_CHAR = /[\\\u0000-\u001f\u007f-\u009f]/;
const AUTH_ROUTES = ["/auth", "/login", UPDATE_PASSWORD_PATH];

export function safeNextPath(next: string | null | undefined): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return "/";
  if (!startsWithOneSlash(next) || UNSAFE_CHAR.test(next)) return "/";

  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return "/"; // malformed percent-encoding
  }
  if (!startsWithOneSlash(decoded) || UNSAFE_DECODED_CHAR.test(decoded)) return "/";

  let url: URL;
  try {
    url = new URL(next, PLACEHOLDER_ORIGIN);
  } catch {
    return "/";
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return "/";

  const path = url.pathname.toLowerCase();
  if (AUTH_ROUTES.some((r) => path === r || path.startsWith(`${r}/`))) return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}

function startsWithOneSlash(value: string): boolean {
  return value.startsWith("/") && value[1] !== "/" && value[1] !== "\\";
}

// ── Passwords ───────────────────────────────────────────────────────────────
// The first problem with a new password, or null when it can be sent.
// Checked before the recovery token is spent, so a typo never costs the
// link. Supabase Auth still applies the project's own policy on save.
export function newPasswordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return `Use at most ${MAX_PASSWORD_BYTES} characters.`;
  }
  if (password !== confirm) return "The two passwords do not match.";
  return null;
}

// What an updateUser({ password }) refusal becomes. The token is spent by
// then, so each one ends with a new link; the code travels in the URL and
// the text is ours, never Supabase's message echoed back.
export type ResetFailure = "weak_password" | "same_password" | "update_failed";

export function resetFailureCode(error: { code?: string | null } | null | undefined): ResetFailure {
  if (error?.code === "weak_password") return "weak_password";
  if (error?.code === "same_password") return "same_password";
  return "update_failed";
}

// ── Messages ────────────────────────────────────────────────────────────────
export type AuthNotice = {
  message: string;
  // The next step, as a link.
  action?: { label: string; href: string };
};

const REQUEST_NEW_LINK = { label: "Request a new reset link", href: FORGOT_PASSWORD_PATH };

// The message /login shows for its ?error= codes.
export function loginErrorMessage(code: string | null | undefined): AuthNotice | null {
  switch (code) {
    case "invalid_link":
      return {
        message:
          "That link is invalid, has expired or was already used. Request a new one, or sign in with your password or a magic link below.",
        action: REQUEST_NEW_LINK,
      };
    case "reset_unavailable":
      return {
        message:
          "That reset link could not be used here. Request a new reset link; if it happens again, tell the platform admin the reset email template needs updating.",
        action: REQUEST_NEW_LINK,
      };
    case "not_team":
      return { message: "That account does not have access to the Compass team platform." };
    default:
      return null;
  }
}

// The message /login/forgot-password shows after a reset that did not save.
export function forgotPasswordErrorMessage(code: string | null | undefined): string | null {
  switch (code) {
    case "weak_password":
      return "Your password was not changed: it does not meet the password policy. Reset links work once, so request a new one and choose a longer or stronger password.";
    case "same_password":
      return "Your password was not changed: the new password was the same as the old one, which still works. To change it anyway, request a new link and choose a different password.";
    case "update_failed":
      return "Your password was not changed because of an error. Reset links work once, so request a new one and try again.";
    default:
      return null;
  }
}

// True when an access token Supabase Auth just issued records a password
// recovery ("amr": [{ "method": "recovery" }]). That is what a recovery link
// opened with the default email template produces (the PKCE ?code= form).
// /auth/confirm never lets such a session stand in for the reset form. Only
// for tokens received straight from Supabase Auth; the signature is not
// checked here.
export function tokenRecordsRecovery(accessToken: string | null | undefined): boolean {
  const payload = accessToken?.split(".")[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
    ) as { amr?: { method?: string }[] };
    return Array.isArray(claims.amr) && claims.amr.some((a) => a?.method === "recovery");
  } catch {
    return false;
  }
}
