import test from "node:test";
import assert from "node:assert/strict";
import { createBillingStore } from "../supabase/functions/stripe-billing/store.ts";

function client(scope, active = true, team = false) {
  const row = { id: "portal-a", client_id: "client-a", auth_user_id: "user-a", is_active: active, access_scope: scope };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-a" } } }) },
    from(table) {
      const filters = [];
      return {
        select() { return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        async maybeSingle() {
          const candidate = table === "team_members" ? (team ? { id: "team-a", role: "admin", auth_user_id: "user-a" } : null) : row;
          return { data: candidate && filters.every(([key,value]) => candidate[key] === value) ? candidate : null, error: null };
        },
      };
    },
  };
}
test("billing caller refuses leads-only and inactive contacts, preserves full contacts and team", async () => {
  assert.equal(await createBillingStore(client("leads_only")).caller("jwt"), null);
  assert.equal(await createBillingStore(client("full", false)).caller("jwt"), null);
  assert.deepEqual(await createBillingStore(client("full")).caller("jwt"), { kind: "portal", portalUserId: "portal-a", clientId: "client-a" });
  assert.deepEqual(await createBillingStore(client("leads_only", true, true)).caller("jwt"), { kind: "team", memberId: "team-a", role: "admin" });
});
