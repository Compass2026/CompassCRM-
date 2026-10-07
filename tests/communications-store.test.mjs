// The communications / twilio-webhook stores' Vault path (0065) over a fake
// supabase-js client: what reaches PostgREST, and how its answers are read.
// The real PostgREST path is covered by tests/communications-integration.mjs
// (the sandbox replay behind PostgREST) and the SQL by
// supabase/tests/sandbox/communications_secrets.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore as createCommsStore } from "../supabase/functions/communications/store.ts";
import { createStore as createWebhookStore } from "../supabase/functions/twilio-webhook/store.ts";

// Built, not written out: a literal SID trips secret scanning.
const SID = "AC" + "4af8abc3".repeat(4);
const LONG = `TWILIO_SUB_${SID}_AUTH_TOKEN`;

function fakeSupabase(answer) {
  const calls = [];
  return {
    calls,
    async rpc(fn, args) { calls.push({ fn, args }); return typeof answer === "function" ? answer(fn, args) : answer; },
  };
}

test("get_secret: a 56-character dynamic name is sent as is; 200 + null is 'not in Vault'", async () => {
  assert.equal(LONG.length, 56);
  const sb = fakeSupabase({ data: null, error: null });
  assert.equal(await createCommsStore(sb).secret(LONG), null);
  assert.deepEqual(sb.calls, [{ fn: "get_secret", args: { secret_name: LONG } }]);
});

test("get_secret: a PostgREST error is an error, never 'not in Vault'", async () => {
  const sb = fakeSupabase({ data: null, error: { message: "permission denied for function get_secret", code: "42501" } });
  await assert.rejects(createCommsStore(sb).secret(LONG), /^Error: vault_read: could not read TWILIO_SUB_/);
  await assert.rejects(createWebhookStore(sb).secret(LONG), /vault_read/);
});

test("subaccountSecrets: one RPC by account SID, mapped with the expected names; values never in errors", async () => {
  const sb = fakeSupabase({
    data: {
      account_sid: SID, api_key: "SK" + "f".repeat(32), api_secret: "key-secret-placeholder", auth_token: "token-placeholder-000000000000000",
      api_key_name: `TWILIO_SUB_${SID}_API_KEY`, api_secret_name: `TWILIO_SUB_${SID}_API_SECRET`, auth_token_name: LONG,
      auth_token_found_as: LONG, other_auth_token_accounts: ["AC" + "1".repeat(32)],
    },
    error: null,
  });
  const v = await createCommsStore(sb).subaccountSecrets(SID);
  assert.deepEqual(sb.calls, [{ fn: "communication_subaccount_secrets", args: { p_account_sid: SID } }]);
  assert.equal(v.authToken, "token-placeholder-000000000000000");
  assert.equal(v.keySid, "SK" + "f".repeat(32));
  assert.equal(v.names.authToken, LONG);
  assert.equal(v.authTokenFoundAs, LONG);
  assert.deepEqual(v.otherAuthTokenAccounts, ["AC" + "1".repeat(32)]);

  const missing = await createCommsStore(fakeSupabase({ data: { auth_token: null, api_key: null, api_secret: null, auth_token_name: LONG,
    api_key_name: "k", api_secret_name: "s", auth_token_found_as: null, other_auth_token_accounts: [] }, error: null })).subaccountSecrets(SID);
  assert.equal(missing.authToken, null);
  assert.equal(missing.names.authToken, LONG);

  const down = fakeSupabase({ data: null, error: { message: "timeout" } });
  await assert.rejects(createCommsStore(down).subaccountSecrets(SID), (e) => /^vault_read:/.test(e.message) && !/placeholder/.test(e.message));
});

test("twilio-webhook reads the Auth Token through the same RPC", async () => {
  const sb = fakeSupabase({ data: { auth_token: "token-placeholder-000000000000000" }, error: null });
  assert.equal(await createWebhookStore(sb).authToken(SID), "token-placeholder-000000000000000");
  assert.deepEqual(sb.calls, [{ fn: "communication_subaccount_secrets", args: { p_account_sid: SID } }]);
  assert.equal(await createWebhookStore(fakeSupabase({ data: { auth_token: null }, error: null })).authToken(SID), null);
  await assert.rejects(createWebhookStore(fakeSupabase({ data: null, error: { message: "x" } })).authToken(SID), /vault_read/);
});
