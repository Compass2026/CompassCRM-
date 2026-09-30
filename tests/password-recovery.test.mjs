// Password recovery rules (src/lib/password-recovery.ts). The end-to-end
// flows against a real Supabase Auth server are tests/auth-flows-ui.mjs
// (npm run test:auth-ui).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORGOT_PASSWORD_PATH,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  forgotPasswordErrorMessage,
  isRecoveryTokenHash,
  loginErrorMessage,
  newPasswordProblem,
  resetFailureCode,
  safeNextPath,
  tokenRecordsRecovery,
} from "../src/lib/password-recovery.ts";

test("safeNextPath keeps same-origin app paths, rebuilt from the parsed URL", () => {
  assert.equal(safeNextPath("/"), "/");
  assert.equal(safeNextPath("/clients/abc?tab=plan"), "/clients/abc?tab=plan");
  assert.equal(safeNextPath("/tasks#mine"), "/tasks#mine");
  assert.equal(safeNextPath("/portal/reports"), "/portal/reports");
  assert.equal(safeNextPath("/clients/a%20b"), "/clients/a%20b");
  // Dot segments are resolved, and can never climb above the origin.
  assert.equal(safeNextPath("/clients/../tasks"), "/tasks");
  assert.equal(safeNextPath("/../../etc/passwd"), "/etc/passwd");
});

test("safeNextPath refuses every value that could leave the Compass origin", () => {
  const malicious = [
    // absent / empty / not a string
    null,
    undefined,
    "",
    42,
    // absolute and scheme URLs
    "https://evil.com",
    "http://evil.com/login",
    "HTTPS://EVIL.COM",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:a@evil.com",
    // not root-relative
    "evil.com",
    "evil.com/path",
    "./clients",
    "?next=//evil.com",
    // protocol-relative and its disguises
    "//evil.com",
    "///evil.com",
    "////evil.com/path",
    "/\\evil.com",
    "\\\\evil.com",
    "\\/evil.com",
    "/\\/evil.com",
    "/%2F%2Fevil.com",
    "/%2fevil.com",
    "/%5Cevil.com",
    "/%5c%5cevil.com",
    "%2F%2Fevil.com",
    // control characters and whitespace that URL parsing strips
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r\n/evil.com",
    "/%09/evil.com",
    "/%0a/evil.com",
    " //evil.com",
    "/ /evil.com",
    "/\u0000/evil.com",
    "/\u0085/evil.com",
    // userinfo / host tricks
    "/@evil.com",
    // malformed percent-encoding
    "/%E0%A4%A",
    "/%",
    // auth routes: loops, sign-out, the reset form
    "/auth/signout",
    "/auth/confirm?next=//evil.com",
    "/AUTH/signout",
    "/login",
    "/login/forgot-password",
    "/update-password",
    "/Update-Password",
    // too long
    `/${"a".repeat(2048)}`,
  ];
  for (const next of malicious) {
    const out = safeNextPath(next);
    // "/@evil.com" is a same-origin path, not a host; everything else is "/".
    if (next === "/@evil.com") {
      assert.equal(out, "/@evil.com");
      assert.equal(new URL(out, "https://compass-crm-ten.vercel.app").host, "compass-crm-ten.vercel.app");
      continue;
    }
    assert.equal(out, "/", JSON.stringify(next));
  }
});

test("safeNextPath output never resolves off-origin, whatever the input", () => {
  const origin = "https://compass-crm-ten.vercel.app";
  const inputs = ["//evil.com", "/\\evil.com", "/%2F%2Fevil.com", "/\t/evil.com", "https://evil.com", "/ok", "/a/../b"];
  for (const next of inputs) {
    assert.equal(new URL(safeNextPath(next), origin).origin, origin, JSON.stringify(next));
  }
});

test("isRecoveryTokenHash accepts Supabase token hashes only", () => {
  const hex56 = "a".repeat(56);
  assert.equal(isRecoveryTokenHash(hex56), true);
  assert.equal(isRecoveryTokenHash(`pkce_${hex56}`), true);
  for (const bad of [null, undefined, "", "abc", "Z".repeat(56), `${hex56}'`, `${hex56}\n`, `pkce_`, "x".repeat(300), `../${hex56}`]) {
    assert.equal(isRecoveryTokenHash(bad), false, JSON.stringify(bad));
  }
});

test("newPasswordProblem checks length, bytes, then the match", () => {
  const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
  const ok = "a".repeat(MIN_PASSWORD_LENGTH);
  assert.match(newPasswordProblem(short, short), /at least/);
  assert.match(newPasswordProblem("é".repeat(MAX_PASSWORD_BYTES / 2 + 1), "x"), /at most/);
  assert.match(newPasswordProblem(ok, `${ok}b`), /do not match/);
  assert.equal(newPasswordProblem(ok, ok), null);
});

test("resetFailureCode maps Supabase's error codes, never its text", () => {
  assert.equal(resetFailureCode({ code: "weak_password" }), "weak_password");
  assert.equal(resetFailureCode({ code: "same_password" }), "same_password");
  assert.equal(resetFailureCode({ code: "unexpected_failure" }), "update_failed");
  assert.equal(resetFailureCode(null), "update_failed");
  for (const code of ["weak_password", "same_password", "update_failed"]) {
    assert.match(forgotPasswordErrorMessage(code), /not changed/);
  }
  assert.equal(forgotPasswordErrorMessage("<script>"), null);
});

test("loginErrorMessage explains invalid links and offers a new reset link", () => {
  const invalid = loginErrorMessage("invalid_link");
  assert.match(invalid.message, /invalid, has expired or was already used/);
  assert.deepEqual(invalid.action, { label: "Request a new reset link", href: FORGOT_PASSWORD_PATH });
  assert.equal(loginErrorMessage("reset_unavailable").action.href, FORGOT_PASSWORD_PATH);
  assert.match(loginErrorMessage("not_team").message, /access/);
  assert.equal(loginErrorMessage("not_team").action, undefined);
  assert.equal(loginErrorMessage("anything"), null);
  assert.equal(loginErrorMessage(null), null);
});

test("tokenRecordsRecovery reads the amr claim of a Supabase access token", () => {
  const jwt = (claims) =>
    `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  assert.equal(tokenRecordsRecovery(jwt({ amr: [{ method: "recovery", timestamp: 1 }] })), true);
  assert.equal(tokenRecordsRecovery(jwt({ amr: [{ method: "otp", timestamp: 1 }] })), false);
  assert.equal(tokenRecordsRecovery(jwt({ amr: [{ method: "password", timestamp: 1 }] })), false);
  assert.equal(tokenRecordsRecovery(jwt({})), false);
  assert.equal(tokenRecordsRecovery("not-a-jwt"), false);
  assert.equal(tokenRecordsRecovery(null), false);
});
