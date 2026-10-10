import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaymentLinks, tokenHash } from "../src/payment-links.ts";
const token = "a".repeat(43);
const link = { id: "link", state: "ready", client_id: "client", request_id: "request", client_name: "Fictional Client", customer_id: "cus_private", issued_by: "issuer", agreement: {}, livemode: false };
function harness({ state = link, busy = false, error } = {}) {
  const writes = []; let calls = 0; let lease = false;
  const handler = createPaymentLinks({ appUrl: "https://crm.test", store: { caller: async () => "none" },
    links: { read: async h => h === tokenHash(token) ? state : null,
      write: async p => { writes.push(p); if (p.op === "claim") { if (busy || lease) return { busy: true }; lease = true; return state; } lease = false; return {}; } },
    checkout: async () => { calls++; await new Promise(r => setTimeout(r, 10)); if (error) throw error; return { checkout: { session_id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", status: "open" } }; } });
  const call = async body => { const r = await handler(new Request("https://billing.test", { method: "POST", body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  return { call, writes, count: () => calls };
}
test("malformed, expired and revoked capabilities do not reach Checkout", async () => {
  const h = harness({ state: null });
  for (const value of ["wrong", token]) assert.equal((await h.call({ action: "open", token: value })).status, 410);
  assert.equal(h.count(), 0); assert.equal(h.writes.length, 0);
});
test("reading a link creates no Checkout and exposes no internal identifiers", async () => {
  const h = harness(); const r = await h.call({ action: "read", token });
  assert.equal(r.status, 200); assert.equal(r.body.client_name, "Fictional Client");
  for (const field of ["customer_id", "issued_by", "id", "request_id"]) assert.equal(field in r.body, false);
  assert.equal(h.count(), 0); assert.equal(h.writes.length, 0);
});
test("parallel clicks claim once and release the lease with the session id", async () => {
  const h = harness(); const r = await Promise.all([h.call({ action: "open", token }), h.call({ action: "open", token })]);
  assert.deepEqual(r.map(x => x.status).sort(), [200, 409]); assert.equal(h.count(), 1);
  assert.equal(h.writes.at(-1).session_id, "cs_test_1");
});
test("a completed capability cannot create another subscription", async () => {
  const h = harness({ state: { ...link, state: "complete" } });
  assert.equal((await h.call({ action: "open", token })).status, 409); assert.equal(h.count(), 0);
});
test("Stripe failure releases the claim and leaks no customer or error details", async () => {
  const h = harness({ error: new Error("private customer secret") });
  const r = await h.call({ action: "open", token });
  assert.equal(r.status, 503); assert.doesNotMatch(JSON.stringify(r.body), /private|secret/);
  assert.equal(h.writes.at(-1).op, "release");
});
test("anonymous callers cannot issue or revoke links", async () => {
  const h = harness();
  for (const action of ["issue", "revoke"]) assert.equal((await h.call({ action, token })).status, 403);
  assert.equal(h.writes.length, 0);
});
