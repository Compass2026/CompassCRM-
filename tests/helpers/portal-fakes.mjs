// A fake Supabase for the portal-invite request-boundary tests: the query
// chains the handler uses, over an in-memory portal_users table that enforces
// what the database enforces (0037's email key and link / team triggers,
// 0042's one-active-client index, case-insensitive email key and fixed
// client), plus a fake Auth admin API that records every email it would
// have sent. Nothing leaves the process.

export function portalFake({ users = [], portalUsers = [], clients = [], teamEmail = "team@compassmarketing.ai", userPageSize } = {}) {
  const db = {
    team_members: [{ id: "tm-1", auth_user_id: "team-user", email: teamEmail }],
    clients: structuredClone(clients),
    portal_users: structuredClone(portalUsers),
  };
  const auth = structuredClone(users); // { id, email, email_confirmed_at }
  const mail = []; // { kind: "invite" | "magiclink", email, redirectTo }
  const failures = []; // { table?, op?, auth?, when?, times, error }
  let seq = 0;

  // A failure spec matches on table / op / auth call, and optionally on the
  // payload of the write (`when`), so a test can fail exactly the link.
  const takeFailure = (match, payload) => {
    const f = failures.find((x) => Object.entries(match).every(([k, v]) => x[k] === v) && x.times > 0 && (!x.when || x.when(payload ?? {})));
    if (!f) return null;
    f.times -= 1;
    return f.error;
  };

  // ── portal_users constraints ──────────────────────────────────────────────
  const violation = (message, code = "23505") => ({ code, message });
  const checkPortalRow = (row, self) => {
    const others = db.portal_users.filter((r) => r !== self);
    if (others.some((r) => r.email.toLowerCase() === row.email.toLowerCase())) {
      return violation('duplicate key value violates unique constraint "portal_users_email_lower_key"');
    }
    if (row.is_active && row.auth_user_id && others.some((r) => r.is_active && r.auth_user_id === row.auth_user_id)) {
      return violation('duplicate key value violates unique constraint "portal_users_one_active_client"');
    }
    return null;
  };
  const beforeWrite = (row, old) => {
    if (db.team_members.some((t) => t.email.toLowerCase() === row.email.toLowerCase())) {
      return { code: "P0001", message: `Cannot invite ${row.email} to the portal: that address is a Compass team member` };
    }
    if (old && row.client_id !== old.client_id) {
      return violation(`A portal contact belongs to one client: revoke ${old.email} and invite them from the other client instead`, "23514");
    }
    if (!row.auth_user_id) {
      const u = auth.find((x) => x.email.toLowerCase() === row.email.toLowerCase());
      if (u && (!old || row.email !== old.email)) row.auth_user_id = u.id; // link_portal_user
    }
    return null;
  };

  class Query {
    constructor(table) { Object.assign(this, { table, filters: [], op: "select", payload: null, returning: false }); }
    select() { if (this.op !== "select") this.returning = true; return this; }
    eq(k, v) { this.filters.push([k, v]); return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    match() { return (db[this.table] ?? []).filter((r) => this.filters.every(([k, v]) => r[k] === v)); }
    run() {
      const injected = takeFailure({ table: this.table, op: this.op }, this.payload);
      if (injected) return { data: null, error: injected };
      if (this.op === "insert") {
        const row = { id: `pu-${++seq}`, auth_user_id: null, is_active: true, last_seen_at: null, ...this.payload };
        const err = (this.table === "portal_users" && (beforeWrite(row, null) || checkPortalRow(row, null))) || null;
        if (err) return { data: null, error: err };
        db[this.table].push(row);
        return { data: [structuredClone(row)], error: null };
      }
      if (this.op === "update") {
        const rows = this.match();
        for (const r of rows) {
          const next = { ...r, ...this.payload };
          const err = (this.table === "portal_users" && (beforeWrite(next, r) || checkPortalRow(next, r))) || null;
          if (err) return { data: null, error: err };
        }
        for (const r of rows) Object.assign(r, this.payload);
        return { data: rows.map((r) => structuredClone(r)), error: null };
      }
      return { data: this.match().map((r) => structuredClone(r)), error: null };
    }
    single() { const r = this.run(); return Promise.resolve(r.error ? r : r.data.length === 1 ? { data: r.data[0], error: null } : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } }); }
    maybeSingle() { const r = this.run(); return Promise.resolve(r.error ? r : { data: r.data[0] ?? null, error: null }); }
    then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject(e); } }
  }

  const supabase = {
    from: (table) => new Query(table),
    auth: {
      getUser: async (jwt) => ({ data: { user: jwt === "team-jwt" ? { id: "team-user" } : jwt === "client-jwt" ? { id: "someone" } : null } }),
      signInWithOtp: async ({ email, options }) => {
        const err = takeFailure({ auth: "otp" });
        if (err) return { data: null, error: err };
        const u = auth.find((x) => x.email.toLowerCase() === email.toLowerCase());
        if (!u && options?.shouldCreateUser === false) return { data: null, error: { message: "Signups not allowed for otp" } };
        mail.push({ kind: "magiclink", email, redirectTo: options?.emailRedirectTo });
        return { data: {}, error: null };
      },
      admin: {
        listUsers: async ({ page = 1, perPage = 50 } = {}) => {
          const err = takeFailure({ auth: "list" });
          if (err) return { data: null, error: err };
          return { data: { users: structuredClone(auth.slice((page - 1) * perPage, page * perPage)) }, error: null };
        },
        // GoTrue: creates the user when absent; re-sends to an unconfirmed
        // user; refuses a confirmed one.
        inviteUserByEmail: async (email, { redirectTo } = {}) => {
          const err = takeFailure({ auth: "invite" });
          if (err) return { data: null, error: err };
          let u = auth.find((x) => x.email.toLowerCase() === email.toLowerCase());
          if (u?.email_confirmed_at) return { data: null, error: { message: "A user with this email address has already been registered", status: 422 } };
          if (!u) { u = { id: `auth-${++seq}`, email, email_confirmed_at: null }; auth.push(u); }
          mail.push({ kind: "invite", email, redirectTo });
          return { data: { user: structuredClone(u) }, error: null };
        },
        generateLink: async () => { throw new Error("generateLink must not be used: it does not send anything"); },
      },
    },
  };

  return {
    supabase,
    db,
    auth,
    mail,
    userPageSize,
    fail: (spec, error = { message: "injected failure" }, times = 1) => failures.push({ ...spec, error, times }),
    // Remove a row behind the handler's back (a concurrent delete).
    removeRow: (id) => { db.portal_users = db.portal_users.filter((r) => r.id !== id); },
  };
}
