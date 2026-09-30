// Password recovery (Sept 30 2026): pure rules shared by /auth/confirm, the
// forgot-password page and /update-password.
//
// No Next.js imports here, so tests/password-recovery.test.mjs can run it.

export const UPDATE_PASSWORD_PATH = "/update-password";

export const MIN_PASSWORD_LENGTH = 8;

// Where /auth/confirm may send a signed-in user after it verifies a link.
// Only a same-site path: "/x" yes; "//evil.com", "/\\evil.com",
// "https://evil.com" or anything without a leading slash falls back to "/".
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  // Control characters (a tab or newline inside "/\t/evil.com") are dropped
  // by URL parsing and could turn the path into a protocol-relative URL.
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  return next;
}

// The first problem with a new password, or null when it can be sent.
// Supabase Auth enforces its own policy as well; this only catches the
// obvious before a round trip.
export function newPasswordProblem(
  password: string,
  confirm: string,
): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirm) return "The two passwords do not match.";
  return null;
}

// The message /login shows for its ?error= codes.
export function loginErrorMessage(code: string | null | undefined): string | null {
  switch (code) {
    case "invalid_link":
      return "That link is invalid or has expired. Request a new one below.";
    case "not_team":
      return "That account does not have access to the Compass team platform.";
    default:
      return null;
  }
}
