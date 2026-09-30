// Password recovery rules (src/lib/password-recovery.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PASSWORD_LENGTH,
  UPDATE_PASSWORD_PATH,
  loginErrorMessage,
  newPasswordProblem,
  safeNextPath,
} from "../src/lib/password-recovery.ts";

test("safeNextPath keeps same-site paths", () => {
  assert.equal(safeNextPath(UPDATE_PASSWORD_PATH), "/update-password");
  assert.equal(safeNextPath("/clients/abc?tab=plan"), "/clients/abc?tab=plan");
  assert.equal(safeNextPath("/"), "/");
});

test("safeNextPath refuses anything that could leave the site", () => {
  for (const next of [
    null,
    undefined,
    "",
    "https://evil.com",
    "evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "javascript:alert(1)",
  ]) {
    assert.equal(safeNextPath(next), "/", String(next));
  }
});

test("newPasswordProblem checks length, then the match", () => {
  const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
  const ok = "a".repeat(MIN_PASSWORD_LENGTH);
  assert.match(newPasswordProblem(short, short), /at least/);
  assert.match(newPasswordProblem(ok, ok + "b"), /do not match/);
  assert.equal(newPasswordProblem(ok, ok), null);
});

test("loginErrorMessage knows the confirm and signout codes only", () => {
  assert.match(loginErrorMessage("invalid_link"), /expired/);
  assert.match(loginErrorMessage("not_team"), /access/);
  assert.equal(loginErrorMessage("anything"), null);
  assert.equal(loginErrorMessage(null), null);
});
