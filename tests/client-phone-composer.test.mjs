// The CRM Lite text composer's rules (src/lib/client-phone-composer.ts): what
// a press of Send leaves in the composer, when the request id changes, and
// which keys send. The browser wiring is checked in tests/crm-lite-ui.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterSend, canPress, classifySend, newComposer, sendsOnKey } from "../src/lib/client-phone-composer.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("composer: accepted clears the text and starts a new request id", () => {
  const c = afterSend(newComposer("Hello", A), { kind: "accepted" }, B);
  assert.equal(c.body, "");
  assert.equal(c.requestId, B);
  assert.equal(c.checking, false);
});

test("composer: text typed while the send was in flight survives acceptance", () => {
  const c = afterSend({ ...newComposer("Hello, and one more thing", A), sentBody: "Hello" }, { kind: "accepted" }, B);
  assert.equal(c.body, "Hello, and one more thing");
  assert.equal(c.requestId, B);
});

test("composer: a failure keeps the text, explains it, and uses a new id for the next try", () => {
  const c = afterSend(newComposer("Hello", A), { kind: "failed", code: "provider_refused" }, B);
  assert.equal(c.body, "Hello");
  assert.equal(c.requestId, B);
  assert.match(c.error, /carrier refused/);
  const notSent = afterSend(newComposer("Hello", A), { kind: "failed", code: "not_sent" }, B);
  assert.match(notSent.error, /was not sent/);
});

test("composer: an uncertain or unanswered send keeps the text and the same id (the next press only checks it)", () => {
  for (const outcome of [{ kind: "uncertain", code: "send_uncertain" }, { kind: "network" }]) {
    const c = afterSend(newComposer("Hello", A), outcome, B);
    assert.equal(c.body, "Hello");
    assert.equal(c.requestId, A, outcome.kind);
    assert.equal(c.checking, true);
    assert.equal(c.sentBody, "Hello");
    assert.match(c.notice, /won't be sent twice/);
  }
});

test("composer: a refusal before anything was reserved keeps the text and the id", () => {
  const c = afterSend(newComposer("Hello", A), { kind: "refused", code: "no_consent" }, B);
  assert.equal(c.body, "Hello");
  assert.equal(c.requestId, A);
  assert.match(c.error, /permission to be texted/);
  assert.match(afterSend(newComposer("x", A), { kind: "refused", code: "opted_out" }, B).error, /STOP/);
});

test("composer: the reply decides the outcome; no answer or a gateway error is never treated as failed", () => {
  assert.deepEqual(classifySend(200, { send: { state: "accepted" } }), { kind: "accepted" });
  assert.deepEqual(classifySend(200, { send: { state: "failed", code: "not_sent" } }), { kind: "failed", code: "not_sent" });
  assert.deepEqual(classifySend(200, { send: { state: "uncertain", code: "send_uncertain" } }), { kind: "uncertain", code: "send_uncertain" });
  assert.deepEqual(classifySend(409, { error: "no_consent" }), { kind: "refused", code: "no_consent" });
  assert.deepEqual(classifySend(null, null), { kind: "network" });
  assert.deepEqual(classifySend(502, { error: "bad gateway" }), { kind: "network" });
  assert.deepEqual(classifySend(200, "not json"), { kind: "network" });
});

test("composer: Enter sends, Shift+Enter does not, and an IME composition never sends", () => {
  assert.equal(sendsOnKey({ key: "Enter", shiftKey: false }), true);
  assert.equal(sendsOnKey({ key: "Enter", shiftKey: true }), false);
  assert.equal(sendsOnKey({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(sendsOnKey({ key: "Enter", shiftKey: false, keyCode: 229 }), false);
  assert.equal(sendsOnKey({ key: "a", shiftKey: false }), false);
});

test("composer: Send is off when empty, too long, not allowed, or already sending; Check status stays available", () => {
  const ok = { canSend: true, sending: false };
  assert.equal(canPress(newComposer("", A), ok), false);
  assert.equal(canPress(newComposer("   \n ", A), ok), false);
  assert.equal(canPress(newComposer("x".repeat(1601), A), ok), false);
  assert.equal(canPress(newComposer("Hi", A), { canSend: false, sending: false }), false);
  assert.equal(canPress(newComposer("Hi", A), { canSend: true, sending: true }), false);
  assert.equal(canPress(newComposer("Hi", A), ok), true);
  const checking = afterSend(newComposer("Hi", A), { kind: "network" }, B);
  assert.equal(canPress(checking, { canSend: true, sending: false }), true);
  assert.equal(canPress(checking, { canSend: true, sending: true }), false);
});
