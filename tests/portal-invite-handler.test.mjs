// Request-boundary tests for the portal-invite Edge Function: the real handler
// (supabase/functions/portal-invite/handler.ts) over a fake Supabase whose
// portal_users table enforces the database's constraints (0037 + 0042) and
// whose Auth admin API records the emails it would have sent. No network; no
// invitation is ever delivered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPortalInviteHandler } from "../supabase/functions/portal-invite/handler.ts";
import { portalFake } from "./helpers/portal-fakes.mjs";

const A = "00000000-0000-4000-b000-00000000000a";
const B = "00000000-0000-4000-b000-00000000000b";
const CLIENTS = [{ id: A, name: "Client A" }, { id: B, name: "Client B" }];
const REDIRECT = "https://crm.example.test/auth/confirm?next=/portal";

function setup(opts = {}) {
  const fake = portalFake({ clients: CLIENTS, ...opts });
  const handler = createPortalInviteHandler({ supabase: fake.supabase, userPageSize: opts.userPageSize });
  const post = async (body, jwt = "team-jwt") => {
    const res = await handler(new Request("https://fn.local/portal-invite", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  };
  const invite = (email, client_id = A, extra = {}) => post({ client_id, email, redirect_to: REDIRECT, ...extra });
  const row = (email) => fake.db.portal_users.find((r) => r.email === email);
  return { ...fake, post, invite, row };
}
const linkWrite = (p) => "auth_user_id" in p;

// ── Auth ──────────────────────────────────────────────────────────────────────
test("no session → 401, a non-team session → 403; nothing written, nothing sent", async () => {
  const t = setup();
  assert.equal((await t.post({ client_id: A, email: "x@example.test", redirect_to: REDIRECT }, "nope")).status, 401);
  assert.equal((await t.post({ client_id: A, email: "x@example.test", redirect_to: REDIRECT }, "client-jwt")).status, 403);
  assert.equal(t.db.portal_users.length, 0);
  assert.equal(t.mail.length, 0);
});

// ── First-time invites ────────────────────────────────────────────────────────
test("first-time invite: sends one invite and saves the new sign-in's id on that client's row", async () => {
  const t = setup({ portalUsers: [{ id: "pu-other", client_id: B, email: "other@example.test", auth_user_id: null, is_active: true }] });
  const r = await t.invite("New.Contact@Example.test", A, { name: "New Contact" });
  assert.equal(r.status, 200);
  assert.deepEqual({ ok: r.body.ok, status: r.body.status, linked: r.body.linked }, { ok: true, status: "invited", linked: true });
  assert.deepEqual(t.mail, [{ kind: "invite", email: "new.contact@example.test", redirectTo: REDIRECT }]);
  const created = t.auth.find((u) => u.email === "new.contact@example.test");
  const saved = t.row("new.contact@example.test");
  assert.equal(saved.client_id, A);
  assert.equal(saved.auth_user_id, created.id, "the id the invite returned is persisted, so portal_client_id() resolves on first sign-in");
  assert.equal(saved.name, "New Contact");
  assert.equal(t.row("other@example.test").auth_user_id, null, "no other row is touched");
});

test("first-time invite: if saving the link fails, the response is not a success, and a retry heals it", async () => {
  const t = setup();
  t.fail({ table: "portal_users", op: "update", when: linkWrite }, { message: "connection reset" });
  const r1 = await t.invite("first@example.test");
  assert.equal(r1.status, 500);
  assert.equal(r1.body.ok, undefined);
  assert.deepEqual({ saved: r1.body.saved, linked: r1.body.linked }, { saved: true, linked: false });
  assert.match(r1.body.error, /could not be linked/);
  assert.equal(t.row("first@example.test").auth_user_id, null);

  // Same request again: the user the first attempt created is found, linked
  // first, then the (still unaccepted) invite is re-sent.
  const r2 = await t.invite("first@example.test");
  assert.equal(r2.status, 200);
  assert.equal(r2.body.status, "invite_resent");
  const user = t.auth.find((u) => u.email === "first@example.test");
  assert.equal(t.row("first@example.test").auth_user_id, user.id);
  assert.equal(t.db.portal_users.length, 1, "the retry reused the saved row");
  assert.deepEqual(t.mail.map((m) => m.kind), ["invite", "invite"]);
});

test("first-time invite: a link that matches no row (row removed meanwhile) is a failure, not a success", async () => {
  const t = setup();
  t.fail({ table: "portal_users", op: "update", when: (p) => { if (linkWrite(p)) t.removeRow(t.row("gone@example.test")?.id); return false; } });
  const r = await t.invite("gone@example.test");
  assert.equal(r.status, 500);
  assert.equal(r.body.linked, false);
});

// ── Re-invite delivery ────────────────────────────────────────────────────────
test("re-invite of a contact who has signed in: a magic link is actually sent (never generateLink)", async () => {
  const t = setup({
    users: [{ id: "auth-a", email: "back@example.test", email_confirmed_at: "2026-09-01T00:00:00Z" }],
    portalUsers: [{ id: "pu-a", client_id: A, email: "back@example.test", auth_user_id: "auth-a", is_active: false, name: "Kept Name" }],
  });
  const r = await t.invite("back@example.test");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "link_sent");
  assert.deepEqual(t.mail, [{ kind: "magiclink", email: "back@example.test", redirectTo: REDIRECT }]);
  assert.equal(t.row("back@example.test").is_active, true, "re-invite reactivates");
  assert.equal(t.row("back@example.test").name, "Kept Name", "a re-invite without a name keeps the one on file");
});

test("re-invite of a contact who never accepted: the invite is re-sent", async () => {
  const t = setup({
    users: [{ id: "auth-p", email: "pending@example.test", email_confirmed_at: null }],
    portalUsers: [{ id: "pu-p", client_id: A, email: "pending@example.test", auth_user_id: "auth-p", is_active: true }],
  });
  const r = await t.invite("pending@example.test");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "invite_resent");
  assert.deepEqual(t.mail.map((m) => m.kind), ["invite"]);
});

test("re-invite: an existing sign-in is found beyond the first page of users", async () => {
  const filler = Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, email: `filler${i}@example.test`, email_confirmed_at: "2026-09-01T00:00:00Z" }));
  const t = setup({ userPageSize: 2, users: [...filler, { id: "auth-late", email: "late@example.test", email_confirmed_at: "2026-09-01T00:00:00Z" }] });
  const r = await t.invite("late@example.test");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "link_sent", "not mistaken for a new address");
  assert.equal(t.row("late@example.test").auth_user_id, "auth-late");
});

test("re-invite: when the email fails the row is saved, the response says so, and a retry sends it", async () => {
  const t = setup({ users: [{ id: "auth-c", email: "c@example.test", email_confirmed_at: "2026-09-01T00:00:00Z" }] });
  t.fail({ auth: "otp" }, { message: "Email rate limit exceeded" });
  const r1 = await t.invite("c@example.test");
  assert.equal(r1.status, 502);
  assert.deepEqual({ saved: r1.body.saved, linked: r1.body.linked }, { saved: true, linked: true });
  assert.equal(t.mail.length, 0);
  const r2 = await t.invite("c@example.test");
  assert.equal(r2.status, 200);
  assert.equal(r2.body.status, "link_sent");
  assert.equal(t.mail.length, 1);
  assert.equal(t.db.portal_users.length, 1);
});

test("first-time invite: when the invite email fails nothing is linked, and a retry invites and links", async () => {
  const t = setup();
  t.fail({ auth: "invite" }, { message: "Email rate limit exceeded" });
  const r1 = await t.invite("d@example.test");
  assert.equal(r1.status, 502);
  assert.equal(r1.body.linked, false);
  assert.equal(t.auth.length, 0, "no sign-in was created");
  const r2 = await t.invite("d@example.test");
  assert.equal(r2.status, 200);
  assert.equal(r2.body.status, "invited");
  assert.equal(t.row("d@example.test").auth_user_id, t.auth[0].id);
});

test("a failed row save sends nothing", async () => {
  const t = setup();
  t.fail({ table: "portal_users", op: "insert" }, { message: "database unavailable" });
  const r = await t.invite("e@example.test");
  assert.equal(r.status, 400);
  assert.equal(t.mail.length, 0);
  assert.equal(t.auth.length, 0);
});

// ── One sign-in, one client ───────────────────────────────────────────────────
test("attempted cross-client reassignment: 409, the contact stays with its client, nothing sent", async () => {
  const t = setup({
    users: [{ id: "auth-b", email: "shared@example.test", email_confirmed_at: "2026-09-01T00:00:00Z" }],
    portalUsers: [{ id: "pu-b", client_id: B, email: "shared@example.test", auth_user_id: "auth-b", is_active: true }],
  });
  const r = await t.invite("shared@example.test", A);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "other_client");
  assert.equal(t.row("shared@example.test").client_id, B);
  assert.equal(t.mail.length, 0);
});

test("attempted cross-client reassignment of a revoked contact is refused too", async () => {
  const t = setup({ portalUsers: [{ id: "pu-b", client_id: B, email: "old@example.test", auth_user_id: null, is_active: false }] });
  const r = await t.invite("old@example.test", A);
  assert.equal(r.status, 409);
  assert.equal(t.row("old@example.test").client_id, B);
  assert.equal(t.row("old@example.test").is_active, false);
});

test("duplicate active assignment: a sign-in already active for another client is refused before any write", async () => {
  // The same person under a second address, hand-linked on client B.
  const t = setup({
    users: [{ id: "auth-x", email: "x@example.test", email_confirmed_at: "2026-09-01T00:00:00Z" }],
    portalUsers: [{ id: "pu-b", client_id: B, email: "x-alias@example.test", auth_user_id: "auth-x", is_active: true }],
  });
  const r = await t.invite("x@example.test", A);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "active_elsewhere");
  assert.equal(t.row("x@example.test"), undefined, "no row was created for client A");
  assert.equal(t.mail.length, 0);
});

test("duplicate active assignment raced past the check: the database refuses it and the handler reports 409, not success", async () => {
  const t = setup({ users: [{ id: "auth-y", email: "y@example.test", email_confirmed_at: null }] });
  // Between the handler's check and its link, another request activates the
  // same sign-in on client B.
  t.fail({ table: "portal_users", op: "update", when: (p) => {
    if (linkWrite(p)) t.db.portal_users.push({ id: "pu-race", client_id: B, email: "y-alias@example.test", auth_user_id: "auth-y", is_active: true });
    return false;
  } });
  const r = await t.invite("y@example.test", A);
  assert.equal(r.status, 409);
  assert.equal(r.body.linked, false);
  assert.equal(t.mail.length, 0, "an existing sign-in is linked before anything is sent");
});

test("an address that differs only by case from an existing contact is refused", async () => {
  const t = setup({ portalUsers: [{ id: "pu-m", client_id: B, email: "Mixed@Example.test", auth_user_id: null, is_active: true }] });
  const r = await t.invite("mixed@example.test", A);
  assert.equal(r.status, 409);
  assert.equal(t.db.portal_users.length, 1);
  assert.equal(t.mail.length, 0);
});

test("a team address is refused by the database trigger and nothing is sent", async () => {
  const t = setup();
  const r = await t.invite("team@compassmarketing.ai");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /team member/);
  assert.equal(t.mail.length, 0);
});

// ── Revoke and input ──────────────────────────────────────────────────────────
test("revoke is scoped to the client and reports an unknown contact", async () => {
  const t = setup({ portalUsers: [{ id: "pu-b", client_id: B, email: "r@example.test", auth_user_id: null, is_active: true }] });
  const wrongClient = await t.post({ email: "r@example.test", revoke: true, client_id: A });
  assert.equal(wrongClient.status, 404);
  assert.equal(t.row("r@example.test").is_active, true);
  const ok = await t.post({ email: "r@example.test", revoke: true, client_id: B });
  assert.equal(ok.status, 200);
  assert.equal(t.row("r@example.test").is_active, false);
  assert.equal((await t.post({ email: "nobody@example.test", revoke: true })).status, 404);
});

test("bad input is refused before anything is written", async () => {
  const t = setup();
  assert.equal((await t.post({ client_id: A, email: "not-an-email", redirect_to: REDIRECT })).status, 400);
  assert.equal((await t.post({ client_id: A, email: "a@example.test", redirect_to: "http://evil.example" })).status, 400);
  assert.equal((await t.post({ email: "a@example.test", redirect_to: REDIRECT })).status, 400);
  assert.equal((await t.post({ client_id: "00000000-0000-4000-b000-0000000000ff", email: "a@example.test", redirect_to: REDIRECT })).status, 404);
  assert.equal(t.db.portal_users.length, 0);
  assert.equal(t.mail.length, 0);
});
