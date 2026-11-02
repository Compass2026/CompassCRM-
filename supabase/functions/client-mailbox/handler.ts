import {
  SCOPES,
  uuid,
  email,
  b64,
  digest,
  missingScopes,
  returnUrl,
  mime,
  plainText,
  header,
  address,
  type Part,
} from "./mail.ts";
// Structural type keeps this handler testable without a network-bound SDK import.
// deno-lint-ignore no-explicit-any
export type DB = any;
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
function fail(code: string): never {
  throw new Error(code);
}
export function createMailbox(
  db: DB,
  base: string,
  request: typeof fetch = fetch,
) {
  async function one(
    table: string,
    filters: Record<string, unknown>,
    columns = "*",
  ) {
    let q = db.from(table).select(columns);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const r = await q.maybeSingle();
    if (r.error) fail("database_unavailable");
    return r.data;
  }
  async function checked(q: PromiseLike<{ data: unknown; error: unknown }>) {
    const r = await q;
    if (r.error) fail("database_unavailable");
    return r.data;
  }
  async function secret(name: string): Promise<string> {
    const r = await db.rpc("get_secret", { secret_name: name });
    if (r.error) fail("configuration_unavailable");
    return r.data || "";
  }
  async function actor(userId: string, clientId: string) {
    const [client, settings, member, portal] = await Promise.all([
      one("clients", { id: clientId }, "id,status"),
      one(
        "crm_lite_settings",
        { client_id: clientId },
        "enabled,portal_enabled",
      ),
      one("team_members", { auth_user_id: userId }, "id,role,email"),
      one(
        "portal_users",
        { auth_user_id: userId, is_active: true, client_id: clientId },
        "id,email",
      ),
    ]);
    if (
      !client ||
      ["paused", "offboarded"].includes(client.status) ||
      !settings?.enabled
    )
      fail("workspace_unavailable");
    if (!member && (!portal || !settings.portal_enabled)) fail("forbidden");
    return {
      admin: member?.role === "admin",
      portal: !member,
      email: (member?.email || portal?.email || "").toLowerCase(),
    };
  }
  async function box(clientId: string) {
    const b = await one("client_mailboxes", {
      client_id: clientId,
      enabled: true,
    });
    if (!b) fail("mailbox_not_configured");
    return b;
  }
  async function credentials() {
    const [id, key] = await Promise.all([
      secret("CLIENT_MAILBOX_GOOGLE_CLIENT_ID"),
      secret("CLIENT_MAILBOX_GOOGLE_CLIENT_SECRET"),
    ]);
    if (!id || !key) fail("oauth_not_configured");
    return { id, key };
  }
  const callback = base + "/functions/v1/google-connect";
  async function provider(url: string, init: RequestInit = {}) {
    return request(url, {
      ...init,
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
  }
  async function token(b: DB) {
    if (!b.connected_email || !b.token_secret) fail("connect_mailbox_first");
    const c = await credentials(),
      refresh = await secret(b.token_secret);
    if (!refresh) fail("reconnect_required");
    const r = await provider("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.id,
        client_secret: c.key,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    const v = await r.json();
    if (!r.ok || !v.access_token) fail("reconnect_required");
    return v.access_token as string;
  }
  async function gmail(path: string, tok: string, init: RequestInit = {}) {
    const r = await provider(GMAIL + path, {
      ...init,
      headers: {
        Authorization: "Bearer " + tok,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!r.ok)
      fail(r.status === 401 ? "reconnect_required" : "gmail_unavailable");
    return r.json();
  }
  async function oauth(url: URL) {
    const state = url.searchParams.get("state") || "";
    if (!/^mailbox\.[a-f0-9]{64}$/.test(state))
      return json(400, { error: "invalid_oauth_state" });
    const r = await db.rpc("client_mailbox_consume_state", {
      p_hash: await digest(state),
    });
    const s = r.data;
    if (r.error || !s)
      return json(400, {
        error: "expired_oauth_state",
        message: "Return to the CRM and start the connection again.",
      });
    let result = "connection_failed";
    try {
      const a = await actor(s.actor_id, s.client_id),
        b = await box(s.client_id);
      if (
        b.provider === "resend" ||
        s.generation !== b.generation ||
        (!a.admin && (!a.portal || a.email !== b.expected_email))
      )
        fail("forbidden");
      if (url.searchParams.has("error")) fail("permission_not_granted");
      const code = url.searchParams.get("code");
      if (!code || code.length > 4096) fail("invalid_oauth_code");
      const c = await credentials();
      const response = await provider("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: c.id,
          client_secret: c.key,
          code,
          grant_type: "authorization_code",
          redirect_uri: callback,
          code_verifier: s.verifier,
        }),
      });
      const v = await response.json();
      if (!response.ok || !v.access_token || !v.refresh_token)
        fail("consent_required");
      if (missingScopes(v.scope || "").length)
        fail("missing_email_permissions");
      const p = await gmail("/profile", v.access_token);
      if (p.emailAddress?.toLowerCase() !== b.expected_email)
        fail("wrong_google_account");
      // Recheck actor and generation after the external consent/token exchange.
      await actor(s.actor_id, s.client_id);
      const name =
        "CLIENT_MAILBOX_" +
        crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const saved = await db.rpc("set_secret", {
        secret_name: name,
        secret_value: v.refresh_token,
      });
      if (saved.error) fail("connection_failed");
      const updated = await db
        .from("client_mailboxes")
        .update({
          connected_email: b.expected_email,
          connected_at: new Date().toISOString(),
          connected_by: s.actor_id,
          token_secret: name,
          generation: crypto.randomUUID(),
          updated_at: new Date().toISOString(),
        })
        .eq("client_id", s.client_id)
        .eq("generation", s.generation)
        .eq("enabled", true)
        .select("client_id");
      if (updated.error || updated.data?.length !== 1)
        fail("connection_changed_retry");
      result = "connected";
    } catch (e) {
      const safe = [
        "permission_not_granted",
        "wrong_google_account",
        "missing_email_permissions",
        "consent_required",
        "connection_changed_retry",
        "forbidden",
        "workspace_unavailable",
      ];
      if (e instanceof Error && safe.includes(e.message)) result = e.message;
    }
    const dest = new URL(s.return_to);
    dest.searchParams.set("mailbox", result);
    return new Response(null, {
      status: 303,
      headers: {
        Location: dest.toString(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  async function inquiry(clientId: string, id: string) {
    if (!uuid(id)) fail("invalid_inquiry");
    const i = await one(
      "inquiries",
      { id, client_id: clientId },
      "id,email,name",
    );
    if (!i) fail("inquiry_not_found");
    return i;
  }
  async function thread(clientId: string, i: DB, create = false) {
    let t = await one("client_email_threads", {
      client_id: clientId,
      inquiry_id: i.id,
    });
    if (create && !t) {
      if (!email(i.email)) fail("lead_email_required");
      await checked(
        db.from("client_email_threads").upsert(
          {
            client_id: clientId,
            inquiry_id: i.id,
            recipient: i.email.toLowerCase(),
            subject: "Following up on your inquiry",
          },
          { onConflict: "inquiry_id,client_id", ignoreDuplicates: true },
        ),
      );
      t = await one("client_email_threads", {
        client_id: clientId,
        inquiry_id: i.id,
      });
    }
    if (t && t.recipient !== i.email?.toLowerCase())
      fail("lead_email_changed_contact_support");
    return t;
  }
  async function snapshot(clientId: string, i: DB, userId: string) {
    const t = await thread(clientId, i);
    const d = await one(
      "client_email_drafts",
      { client_id: clientId, inquiry_id: i.id, actor_id: userId },
      "body,revision,updated_at",
    );
    const r = t
      ? await db
          .from("client_email_messages")
          .select(
            "id,sender,recipient,subject,body,status,delivery_status,error_code,message_at",
          )
          .eq("client_id", clientId)
          .eq("thread_id", t.id)
          .order("message_at", { ascending: false })
          .limit(200)
      : { data: [], error: null };
    if (r.error) fail("database_unavailable");
    return {
      draft: d,
      messages: (r.data || []).reverse(),
      subject: t?.subject || "Following up on your inquiry",
      synced_at: t?.synced_at || null,
    };
  }
  async function sync(clientId: string, t: DB, b: DB, tok: string) {
    const uncertain = await db
      .from("client_email_messages")
      .select("*")
      .eq("client_id", clientId)
      .eq("thread_id", t.id)
      .eq("status", "unknown");
    if (uncertain.error) fail("database_unavailable");
    for (const m of uncertain.data || []) {
      const found = await gmail(
        "/messages?maxResults=2&q=" +
          encodeURIComponent("in:sent rfc822msgid:" + m.rfc_message_id),
        tok,
      );
      if (found.messages?.length === 1) {
        const gm = await gmail(
          "/messages/" +
            encodeURIComponent(found.messages[0].id) +
            "?format=full",
          tok,
        );
        if (
          header(gm.payload, "Message-ID") !== m.rfc_message_id ||
          address(header(gm.payload, "From")) !== b.connected_email ||
          address(header(gm.payload, "To")) !== t.recipient
        )
          continue;
        if (t.provider_thread_id && t.provider_thread_id !== gm.threadId)
          continue;
        await checked(
          db
            .from("client_email_threads")
            .update({ provider_thread_id: gm.threadId })
            .eq("id", t.id)
            .eq("client_id", clientId),
        );
        t.provider_thread_id = gm.threadId;
        await checked(
          db
            .from("client_email_messages")
            .update({
              status: "accepted",
              provider_message_id: gm.id,
              error_code: null,
            })
            .eq("id", m.id)
            .eq("client_id", clientId),
        );
      }
    }
    if (t.provider_thread_id) {
      const remote = await gmail(
        "/threads/" + encodeURIComponent(t.provider_thread_id) + "?format=full",
        tok,
      );
      for (const m of remote.messages || []) {
        const p = m.payload as Part,
          from = address(header(p, "From")),
          to = header(p, "To"),
          mid = header(p, "Message-ID");
        // Gmail grouping is not authority to import unrelated senders or recipients.
        if (
          !from ||
          ![t.recipient, b.connected_email].includes(from) ||
          !mid ||
          !/^<[^<>\s]+>$/.test(mid)
        )
          continue;
        const toAddresses = to.split(",").map(address);
        if (
          !toAddresses.includes(
            from === b.connected_email ? t.recipient : b.connected_email,
          )
        )
          continue;
        const body =
          plainText(p) ||
          "[This email has no plain-text body. Open Gmail to read its formatting or attachments.]";
        const row = {
          client_id: clientId,
          thread_id: t.id,
          provider_message_id: m.id,
          rfc_message_id: mid,
          sender: from,
          recipient:
            from === b.connected_email ? t.recipient : b.connected_email,
          subject: header(p, "Subject").slice(0, 200),
          body,
          status: from === b.connected_email ? "accepted" : "received",
          message_at: new Date(Number(m.internalDate)).toISOString(),
        };
        // Never overwrite actor attribution or send receipts when a message already exists.
        await checked(
          db.from("client_email_messages").upsert(row, {
            onConflict: "client_id,rfc_message_id",
            ignoreDuplicates: true,
          }),
        );
      }
    }
    await checked(
      db
        .from("client_email_threads")
        .update({ synced_at: new Date().toISOString() })
        .eq("id", t.id)
        .eq("client_id", clientId),
    );
  }
  return async function handle(req: Request): Promise<Response> {
    if (req.method === "GET") return oauth(new URL(req.url));
    if (req.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    try {
      if (Number(req.headers.get("content-length") || 0) > 20000)
        return json(413, { error: "request_too_large" });
      const raw = await req.text();
      if (raw.length > 20000) return json(413, { error: "request_too_large" });
      const input = JSON.parse(raw);
      if (!uuid(input.client_id)) return json(400, { error: "invalid_client" });
      const auth = req.headers.get("authorization") || "";
      if (!auth.startsWith("Bearer "))
        return json(401, { error: "unauthorized" });
      const { data, error } = await db.auth.getUser(auth.slice(7));
      if (error || !data?.user) return json(401, { error: "unauthorized" });
      const uid = data.user.id,
        cid = input.client_id,
        a = await actor(uid, cid);
      if (input.mode === "configure") {
        if (!a.admin) fail("forbidden");
        const expected = String(input.email || "").toLowerCase();
        if (!email(expected)) fail("invalid_email");
        const old = await one("client_mailboxes", { client_id: cid });
        if (old && old.expected_email !== expected)
          fail("mailbox_already_configured");
        await checked(
          db
            .from("client_mailboxes")
            .upsert(
              { client_id: cid, expected_email: expected },
              { onConflict: "client_id", ignoreDuplicates: true },
            ),
        );
        return json(200, { ok: true });
      }
      if (input.mode === "status") {
        const b = await one("client_mailboxes", { client_id: cid });
        return json(200, {
          configured: !!b?.enabled,
          connected: !!(
            b?.enabled &&
            b.connected_email &&
            (b.provider !== "resend" || b.resend_ready)
          ),
          provider: b?.provider || "google",
          email: b?.expected_email || null,
          can_connect:
            b?.provider !== "resend" &&
            (a.admin || (a.portal && a.email === b?.expected_email)),
        });
      }
      const b = await box(cid);
      if (input.mode === "connect") {
        if (b.provider === "resend") fail("email_not_ready");
        if (!a.admin && (!a.portal || a.email !== b.expected_email))
          fail("forbidden");
        const setting = await one(
          "app_settings",
          { key: "client_mailbox_origins" },
          "value",
        );
        const allowed = Array.isArray(setting?.value) ? setting.value : [];
        const back = returnUrl(input.origin, allowed, cid, a.portal),
          c = await credentials();
        const state =
          "mailbox." +
          Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
            v.toString(16).padStart(2, "0"),
          ).join("");
        const verifier = b64(
          Array.from(crypto.getRandomValues(new Uint8Array(48)), (v) =>
            String.fromCharCode(v),
          ).join(""),
        );
        // challenge is encoded from bytes, not UTF-8 text.
        const bytes = new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
          ),
        );
        const codeChallenge = btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        await checked(
          db
            .from("client_mailbox_oauth")
            .delete()
            .eq("client_id", cid)
            .eq("actor_id", uid),
        );
        await checked(
          db.from("client_mailbox_oauth").insert({
            state_hash: await digest(state),
            client_id: cid,
            actor_id: uid,
            generation: b.generation,
            verifier,
            return_to: back,
          }),
        );
        const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        consent.search = new URLSearchParams({
          client_id: c.id,
          redirect_uri: callback,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent select_account",
          include_granted_scopes: "false",
          login_hint: b.expected_email,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        }).toString();
        return json(200, { url: consent.toString() });
      }
      const i = await inquiry(cid, input.inquiry_id);
      if (input.mode === "load") return json(200, await snapshot(cid, i, uid));
      if (input.mode === "save_draft") {
        if (typeof input.body !== "string" || input.body.length > 10000)
          fail("invalid_draft");
        await thread(cid, i, true);
        await checked(
          db.from("client_email_drafts").upsert(
            {
              client_id: cid,
              inquiry_id: i.id,
              actor_id: uid,
              body: input.body,
              revision: crypto.randomUUID(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "client_id,inquiry_id,actor_id" },
          ),
        );
        return json(200, await snapshot(cid, i, uid));
      }
      if (input.mode === "sync") {
        const t = await thread(cid, i);
        if (t && b.provider !== "resend") await sync(cid, t, b, await token(b));
        return json(200, await snapshot(cid, i, uid));
      }
      if (input.mode === "send") {
        if (!uuid(input.revision)) fail("invalid_revision");
        const t = await thread(cid, i, true),
          tok =
            b.provider === "resend"
              ? await secret(b.api_key_secret || "CLIENT_RESEND_API_KEY")
              : await token(b);
        if (!tok) fail("email_not_ready");
        await actor(uid, cid); // active authorization checked again immediately before reservation
        const claim = await db.rpc("client_mailbox_claim_send", {
          p_client: cid,
          p_inquiry: i.id,
          p_actor: uid,
          p_revision: input.revision,
        });
        if (claim.error) {
          const known = [
            "send_uncertain_refresh_first",
            "email_not_ready",
            "recipient_suppressed",
            "rate_limited",
            "save_draft_first",
            "request_conflict",
          ];
          fail(
            known.find((k) => claim.error.message.includes(k)) ||
              "send_not_reserved",
          );
        }
        const m = claim.data.message;
        if (!claim.data.claimed)
          return json(200, {
            ...(await snapshot(cid, i, uid)),
            send_status: m.status,
          });
        const previous = await db
          .from("client_email_messages")
          .select("rfc_message_id")
          .eq("client_id", cid)
          .eq("thread_id", t.id)
          .in("status", ["accepted", "received"])
          .order("message_at", { ascending: false })
          .limit(1);
        if (previous.error) fail("send_uncertain_refresh_first");
        let res: Response;
        try {
          res = await provider(
            b.provider === "resend"
              ? "https://api.resend.com/emails"
              : GMAIL + "/messages/send",
            {
              method: "POST",
              headers: {
                Authorization: "Bearer " + tok,
                "Content-Type": "application/json",
                ...(b.provider === "resend"
                  ? { "Idempotency-Key": "crm-" + m.request_id }
                  : {}),
              },
              body: JSON.stringify(
                b.provider === "resend"
                  ? {
                      from: b.sender_name
                        ? `${b.sender_name.replace(/[<>\r\n]/g, "")} <${m.sender}>`
                        : m.sender,
                      to: [m.recipient],
                      subject: m.subject,
                      text: m.body,
                      reply_to: `r.${t.reply_token}@${b.reply_domain}`,
                      headers: {
                        "Message-ID": m.rfc_message_id,
                        ...(previous.data?.[0]?.rfc_message_id
                          ? {
                              "In-Reply-To": previous.data[0].rfc_message_id,
                              References: previous.data[0].rfc_message_id,
                            }
                          : {}),
                      },
                      tags: [{ name: "crm_message_id", value: m.id }],
                    }
                  : {
                      raw: mime(m, previous.data?.[0]?.rfc_message_id),
                      ...(t.provider_thread_id
                        ? { threadId: t.provider_thread_id }
                        : {}),
                    },
              ),
            },
          );
        } catch {
          return json(200, {
            ...(await snapshot(cid, i, uid)),
            send_status: "unknown",
          });
        }
        const sent = await res.json().catch(() => null);
        if (!res.ok) {
          // Only deterministic rejections are safe to mark failed; server errors may have sent.
          const status =
            res.status >= 400 && res.status < 500 ? "failed" : "unknown";
          await checked(
            db
              .from("client_email_messages")
              .update({ status, error_code: b.provider + "_" + res.status })
              .eq("id", m.id)
              .eq("client_id", cid),
          );
          return json(200, {
            ...(await snapshot(cid, i, uid)),
            send_status: status,
          });
        }
        if (!sent?.id || (b.provider !== "resend" && !sent?.threadId))
          return json(200, {
            ...(await snapshot(cid, i, uid)),
            send_status: "unknown",
          });
        if (b.provider !== "resend")
          await checked(
            db
              .from("client_email_threads")
              .update({ provider_thread_id: sent.threadId })
              .eq("id", t.id)
              .eq("client_id", cid),
          );
        await checked(
          db
            .from("client_email_messages")
            .update({ status: "accepted", provider_message_id: sent.id })
            .eq("id", m.id)
            .eq("client_id", cid),
        );
        await checked(
          db
            .from("client_email_drafts")
            .delete()
            .eq("client_id", cid)
            .eq("inquiry_id", i.id)
            .eq("actor_id", uid)
            .eq("revision", input.revision),
        );
        return json(200, {
          ...(await snapshot(cid, i, uid)),
          send_status: "accepted",
        });
      }
      return json(400, { error: "unknown_mode" });
    } catch (e) {
      const safe = [
        "forbidden",
        "workspace_unavailable",
        "invalid_return_origin",
        "mailbox_not_configured",
        "oauth_not_configured",
        "invalid_email",
        "mailbox_already_configured",
        "invalid_inquiry",
        "inquiry_not_found",
        "lead_email_required",
        "lead_email_changed_contact_support",
        "connect_mailbox_first",
        "reconnect_required",
        "gmail_unavailable",
        "email_not_ready",
        "recipient_suppressed",
        "rate_limited",
        "invalid_draft",
        "invalid_revision",
        "send_uncertain_refresh_first",
        "save_draft_first",
        "request_conflict",
        "send_not_reserved",
      ];
      const code =
        e instanceof Error && safe.includes(e.message)
          ? e.message
          : "request_failed";
      return json(code === "forbidden" ? 403 : 409, { error: code });
    }
  };
}
