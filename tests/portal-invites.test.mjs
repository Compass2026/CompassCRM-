// The Client portal invite flag (src/lib/portal-invites.ts). Merging to main
// deploys the CRM, so invites must stay off until the flag is set on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PORTAL_INVITES_FLAG,
  PORTAL_INVITES_OFF_MESSAGE,
  portalInvitesEnabled,
  runPortalInvite,
} from "../src/lib/portal-invites.ts";

const CLIENT = "00000000-0000-4000-b000-00000000000a";

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function deps(env) {
  const sent = [];
  return {
    sent,
    env,
    send: async (body) => { sent.push(body); },
    origin: async () => "https://compass-crm.example.test",
  };
}

test("the flag is named PORTAL_INVITES_ENABLED and is off unless exactly 'true'", () => {
  assert.equal(PORTAL_INVITES_FLAG, "PORTAL_INVITES_ENABLED");
  assert.equal(portalInvitesEnabled({}), false, "unset");
  for (const v of ["", "false", "0", "1", "yes", "on", "TRUE", "True", " true", "true "]) {
    assert.equal(portalInvitesEnabled({ PORTAL_INVITES_ENABLED: v }), false, JSON.stringify(v));
  }
  assert.equal(portalInvitesEnabled({ PORTAL_INVITES_ENABLED: "true" }), true);
  // A public (browser-inlined) variable of a similar name does not count.
  assert.equal(portalInvitesEnabled({ NEXT_PUBLIC_PORTAL_INVITES_ENABLED: "true" }), false);
});

test("flag off: an invite submitted directly is refused and nothing is sent", async () => {
  for (const env of [{}, { PORTAL_INVITES_ENABLED: "false" }, { PORTAL_INVITES_ENABLED: "1" }]) {
    const d = deps(env);
    await assert.rejects(
      runPortalInvite(d, CLIENT, form({ email: "owner@client.example.test", name: "Owner" })),
      { message: PORTAL_INVITES_OFF_MESSAGE }
    );
    assert.deepEqual(d.sent, [], `nothing sent with ${JSON.stringify(env)}`);
  }
});

test("flag off: refused before the form is even read (an empty form gets the flag message, not a validation one)", async () => {
  const d = deps({});
  await assert.rejects(runPortalInvite(d, CLIENT, form({})), { message: PORTAL_INVITES_OFF_MESSAGE });
  assert.deepEqual(d.sent, []);
});

test("flag on: the invite goes to portal-invite exactly as before", async () => {
  const d = deps({ PORTAL_INVITES_ENABLED: "true" });
  await runPortalInvite(d, CLIENT, form({ email: "  owner@client.example.test ", name: " " }));
  assert.deepEqual(d.sent, [{
    client_id: CLIENT,
    email: "owner@client.example.test",
    name: null,
    redirect_to: "https://compass-crm.example.test/auth/confirm?next=/portal",
  }]);
  const d2 = deps({ PORTAL_INVITES_ENABLED: "true" });
  await assert.rejects(runPortalInvite(d2, CLIENT, form({ email: " " })), { message: "Email is required" });
  assert.deepEqual(d2.sent, []);
});

// Static wiring: the server action goes through the guard, revoke does not,
// and the Overview card renders the form only when the flag is on.
test("the invite action is guarded; revoke is not", () => {
  const src = readFileSync("src/app/portal-actions.ts", "utf8");
  const invite = src.slice(src.indexOf("export async function invitePortalUserAction"), src.indexOf("export async function revokePortalUserAction"));
  assert.match(invite, /await runPortalInvite\(\s*\{ env: process\.env, send: callPortalInvite, origin: siteOrigin \}/);
  assert.ok(!invite.includes("callPortalInvite({"), "the action never calls the Edge Function directly");
  const revoke = src.slice(src.indexOf("export async function revokePortalUserAction"));
  assert.ok(revoke.includes("callPortalInvite({ email, revoke: true, client_id: clientId })"));
});

test("the Overview card shows the invite form only when the flag is on", () => {
  const page = readFileSync("src/app/(app)/clients/[clientId]/page.tsx", "utf8");
  assert.match(page, /const invitesEnabled = portalInvitesEnabled\(\);/);
  const branch = page.slice(page.indexOf("{invitesEnabled ? ("));
  const on = branch.slice(0, branch.indexOf(") : ("));
  const off = branch.slice(branch.indexOf(") : ("), branch.indexOf("          )}"));
  assert.ok(on.includes("action={invitePortalUser}") && on.includes("Send invite"), "form in the on branch");
  assert.ok(!off.includes("<form") && !off.includes("Send invite"), "no form in the off branch");
  assert.match(off, /Invites are switched off for now\./);
  assert.equal((page.match(/action=\{invitePortalUser\}/g) ?? []).length, 1, "the form exists only once");
  // The flag stays server-side.
  assert.ok(!page.includes("NEXT_PUBLIC_PORTAL_INVITES"));
  const code = readFileSync("src/lib/portal-invites.ts", "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!code.includes("NEXT_PUBLIC_"), "the flag is not a public, browser-inlined variable");
});
