import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Exercise form handlers without changing a real account or recording credentials.
const source = readFileSync(new URL("../src/components/password-change-form.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness(auth) {
  const states = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, {
    exports,
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } },
    require(name) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react") return {
        useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (value) => { states[index] = value; }]; },
        useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial }; },
      };
      if (name === "@/lib/supabase/client") return { createClient: () => ({ auth }) };
      return { Button: "button", Input: "input", Label: "label" };
    },
  });
  function render() { stateIndex = 0; refIndex = 0; return exports.PasswordChangeForm(); }
  const form = { values: { password: "test-only-new-password", confirmation: "test-only-new-password" }, resets: 0, reset() { this.resets++; } };
  return { render, form, submit: () => render().props.onSubmit({ preventDefault() {}, currentTarget: form }) };
}

test("mismatched passwords never reach Auth", async () => {
  let calls = 0;
  const h = harness({ updateUser: async () => { calls++; } });
  h.form.values.confirmation = "different-test-value";
  await h.submit();
  assert.equal(calls, 0);
  assert.match(JSON.stringify(h.render()), /do not match/);
});

test("successful save clears secrets and reports success only after completion", async () => {
  let finish;
  let calls = 0;
  const h = harness({ updateUser: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const saving = h.submit();
  assert.equal(h.render().props["aria-busy"], true);
  assert.doesNotMatch(JSON.stringify(h.render()), /Password updated/);
  await h.submit();
  assert.equal(calls, 1);
  finish({ error: null });
  await saving;
  assert.equal(h.form.resets, 1);
  assert.equal(h.render().props["aria-busy"], false);
  assert.match(JSON.stringify(h.render()), /Password updated/);
});

test("provider errors leave the form available and never claim success", async () => {
  const h = harness({ updateUser: async () => ({ error: { message: "Password is too weak.", code: "weak_password" } }) });
  await h.submit();
  assert.match(JSON.stringify(h.render()), /Password is too weak/);
  assert.doesNotMatch(JSON.stringify(h.render()), /Password updated/);
  assert.equal(h.form.resets, 0);
  assert.equal(h.render().props["aria-busy"], false);
});

test("secure password change requires user verification and preserves nonce and current password", async () => {
  let calls = 0;
  let codeCalls = 0;
  let submitted;
  const h = harness({
    updateUser: async (values) => { submitted = values; return { error: calls++ === 0 ? { code: "reauthentication_needed" } : null }; },
    reauthenticate: async () => { codeCalls++; return { error: null }; },
  });
  await h.submit();
  const fieldset = h.render().props.children[0];
  const verification = fieldset.props.children[3];
  await verification.props.children[0].props.onClick();
  assert.equal(codeCalls, 1);
  h.form.values.nonce = " test-only-code ";
  h.form.values.currentPassword = "test-only-current-password";
  await h.submit();
  assert.equal(submitted.nonce, "test-only-code");
  assert.equal(submitted.current_password, "test-only-current-password");
  assert.deepEqual(Object.keys(submitted).sort(), ["current_password", "nonce", "password"]);
  assert.match(JSON.stringify(h.render()), /Password updated/);
});

test("network failures clear pending state and allow a retry", async () => {
  const h = harness({ updateUser: async () => { throw new Error("test network failure"); } });
  await h.submit();
  assert.equal(h.render().props["aria-busy"], false);
  assert.match(JSON.stringify(h.render()), /Check your connection/);
  assert.doesNotMatch(JSON.stringify(h.render()), /Password updated/);
});
