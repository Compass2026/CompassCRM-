// The publisher's Facebook path through Zernio (Zernio Social Publisher v1;
// docs/zernio-publisher.md). The handler owns the tick; this owns what
// happens to a Facebook post inside it, with the same guarantees as the
// Business Profile path:
//
// - Only the approved snapshot is sent: the exact approved copy, the exact
//   image (its bytes re-hashed against the hash the approval bound), to the
//   one Zernio account explicitly bound to the snapshot's Facebook Page of
//   the same client, pinned to that Page id.
// - The claim (0045) re-checks the approval fingerprint and grounding, as for
//   every post; a refusal sends the post back to review.
// - Never a second post: every create carries an Idempotency-Key derived from
//   the approval's publish_key; a request without a definite answer is sent
//   again only with the same key (inside Zernio's window) and the same body,
//   and a post Zernio already has is read before anything is sent again. A
//   409 duplicate is a reason to look, never to post again.
// - Recorded published only from Zernio's platform result with the live
//   Facebook URL; anything unclear stays `publishing` (submitted / uncertain)
//   and is reconciled on later ticks, or goes to a person.
//
// Also the read-only verification (accounts), the explicit binding (bind)
// and the no-write preflight.

import { MAX_ATTEMPTS, nextRetryAt, STUCK_AFTER_MINUTES } from "./channel.ts";
import {
  bindingProblems, buildCreateBody, chicago, facebookProblems, IMAGE_TYPES, idempotencyKey, interpretCreate, interpretPost,
  mediaOf, PENDING_TOO_LONG_HOURS, planSend, sameContent, sha256Hex, sniffImage, summarizeHealth, ZERNIO_ACCOUNT_RE,
  ZERNIO_PUBLISH_KEY_SECRET, ZERNIO_READ_KEY_SECRET,
  type Answer, type Binding, type FacebookSnapshot, type MediaRef, type PostState, type ZPost,
} from "./facebook.ts";
import type { PostRow, RunRow, Store } from "./store.ts";
import { createZernioPublisher, ZERNIO_BASE, type ZernioAccount, type ZernioFacebookPage, type ZernioPublisher } from "./zernio.ts";

type Mode = RunRow["mode"];
export type FacebookCtx = {
  store: Store;
  fetch: typeof fetch;
  at: Date;
  settings: { enabled: boolean; clients: string[] };
  run: (r: RunRow) => Promise<void>;
  note: (post_id: string, outcome: string, detail?: string | null) => void;
  resolve: (f: { keys: string[]; client_id?: string; post_id?: string }, why: string) => Promise<void>;
};

const POST_TASK_KEYS = ["publisher_fix_post", "publisher_failed", "publisher_check_post"];
const Z = "zernio" as const;

type Media = { ref: MediaRef; bytes: Uint8Array; type: string; hash: string };

export function createFacebookPath(ctx: FacebookCtx) {
  const { store, at } = ctx;
  const piloted = (clientId: string) => ctx.settings.clients.includes(clientId);
  const postLink = (p: { client_id: string; id: string }) => `/clients/${p.client_id}/social/${p.id}`;
  const accounts = new Map<string, Binding | null>();
  const accountOf = async (id: string | null | undefined): Promise<Binding | null> => {
    if (!id) return null;
    if (!accounts.has(id)) accounts.set(id, await store.account(id));
    return accounts.get(id)!;
  };

  // The publish key, once per run. Never the read key, never returned.
  let zernio: ZernioPublisher | null = null;
  let keyBlock: string | null = null;
  const ensureZernio = async (): Promise<ZernioPublisher | null> => {
    if (zernio || keyBlock) return zernio;
    const key = await store.secret(ZERNIO_PUBLISH_KEY_SECRET);
    const read = await store.secret(ZERNIO_READ_KEY_SECRET);
    if (!key) keyBlock = `${ZERNIO_PUBLISH_KEY_SECRET} is not in Vault.`;
    else if (read && read === key) keyBlock = `${ZERNIO_PUBLISH_KEY_SECRET} is the same key as ${ZERNIO_READ_KEY_SECRET}; publishing needs its own key.`;
    else zernio = createZernioPublisher({ apiKey: key, fetch: ctx.fetch });
    return zernio;
  };

  const zrun = (p: { id: string; client_id: string }, mode: Mode, r: Omit<RunRow, "post_id" | "client_id" | "mode">) =>
    ctx.run({ post_id: p.id, client_id: p.client_id, mode, transport: Z, ...r });

  // A block the post already sits on is not logged again every tick.
  const blockOnce = async (p: PostRow, mode: Mode, detail: string, task_id: string | null = null) => {
    const last = await store.latestRun(p.id);
    if (last?.outcome === "blocked" && last.detail === detail) { ctx.note(p.id, "blocked", detail); return; }
    await zrun(p, mode, { outcome: "blocked", detail, task_id });
  };

  // Would the publisher send this post through Zernio? (Then no hand-posting
  // reminder is opened for it.) Read from the live row; the snapshot decides
  // at send time.
  async function routable(p: PostRow): Promise<boolean> {
    if (p.platform !== "facebook" || !ctx.settings.enabled || !piloted(p.client_id)) return false;
    const b = await accountOf(p.social_account_id);
    return !!b && b.client_id === p.client_id && b.publish_provider === "zernio" && !!b.publish_account_id && b.publish_enabled;
  }

  async function loadMedia(ref: MediaRef): Promise<Media | { problem: string; fix: boolean }> {
    const d = await store.download(ref.bucket, ref.storage_path);
    if (!d) return { problem: "Could not read the approved image from storage.", fix: false };
    const hash = await sha256Hex(d.bytes);
    if (hash !== ref.content_hash) {
      return { problem: `The stored image is not the one approved (sha256 ${hash.slice(0, 12)}…, approved ${ref.content_hash.slice(0, 12)}…).`, fix: true };
    }
    const type = sniffImage(d.bytes);
    if (!type || !IMAGE_TYPES[type]) return { problem: "The image is not a JPEG, PNG or WebP file.", fix: true };
    return { ref, bytes: d.bytes, type, hash };
  }

  const fixPost = async (p: PostRow, mode: Mode, detail: string) => {
    if (p.publish_status === "scheduled") await store.unschedule(p.id);
    const task_id = await store.openTask({
      client_id: p.client_id, key: "publisher_fix_post", post_id: p.id,
      title: "Fix a Facebook post before it can publish",
      notes: `${detail} Reopen the post, fix it, get it approved and schedule it again: ${postLink(p)}. post_id=${p.id}`,
    });
    await zrun(p, mode, { outcome: "blocked", detail, task_id });
  };

  const connectTask = (clientId: string, why: string) => store.openTask({
    client_id: clientId, key: "publisher_connect_zernio",
    title: "Connect Zernio publishing for Facebook",
    notes: `${why} Facebook posts stay scheduled and publish on the next run after it is fixed (Settings → Publisher).`,
  });
  const reconnectTask = (clientId: string, why: string) => store.openTask({
    client_id: clientId, key: "publisher_reconnect_zernio",
    title: "Reconnect the client's Facebook Page in Zernio",
    notes: `${why} Reconnect the Page in Zernio, then verify it again in Settings → Publisher. Facebook posts that failed can be scheduled again afterwards.`,
  });

  // Everything that can be checked before the claim, without writing to Zernio.
  async function gates(p: PostRow, mode: Mode): Promise<{ snap: FacebookSnapshot; binding: Binding; media: Media | null; z: ZernioPublisher } | null> {
    if (!piloted(p.client_id)) {
      await blockOnce(p, mode, "This client is not on the publisher's pilot list (Settings → Publisher).");
      return null;
    }
    const snap = (p.approved_snapshot ?? {}) as FacebookSnapshot;
    const problems = facebookProblems(snap);
    if (problems.length) {
      await fixPost(p, mode, `Not publishable as approved: ${problems.map((x) => x.message).join(" ")}`);
      return null;
    }
    const binding = await accountOf(snap.social_account_id);
    const bp = bindingProblems({ client_id: p.client_id, platform: p.platform, social_account_id: snap.social_account_id ?? null }, binding);
    if (bp.length) {
      const unbound = !binding || !binding.publish_account_id;
      const task_id = unbound && binding?.client_id === p.client_id ? await connectTask(p.client_id, bp.join(" ")) : null;
      await blockOnce(p, mode, bp.join(" "), task_id);
      return null;
    }
    const z = await ensureZernio();
    if (!z) {
      await blockOnce(p, mode, keyBlock!, await connectTask(p.client_id, keyBlock!));
      return null;
    }
    let media: Media | null = null;
    const ref = mediaOf(snap)[0];
    if (ref) {
      const m = await loadMedia(ref);
      if ("problem" in m) {
        if (m.fix) await fixPost(p, mode, m.problem);
        else await blockOnce(p, mode, m.problem);
        return null;
      }
      media = m;
    }
    return { snap, binding: binding!, media, z };
  }

  const failure = async (p: PostRow, mode: Mode, o: { detail: string; transient: boolean; http_status?: number | null; provider_post_id?: string | null; provider_status?: string | null; request_key?: string | null; target: string }) => {
    await store.markFailed(p.id, o.detail);
    const final = !o.transient || p.publish_attempts >= MAX_ATTEMPTS;
    let task_id: string | null = null;
    if (final) {
      task_id = await store.openTask({
        client_id: p.client_id, key: "publisher_failed", post_id: p.id,
        title: "A Facebook post failed to publish",
        notes: `${o.detail} (attempt ${p.publish_attempts} of ${MAX_ATTEMPTS}${o.transient ? "" : "; not retried automatically"}). Open ${postLink(p)}. post_id=${p.id}`,
      });
    }
    await zrun(p, mode, {
      outcome: "failed", transient: o.transient, http_status: o.http_status ?? null, detail: o.detail, task_id,
      provider_post_id: o.provider_post_id ?? null, provider_status: o.provider_status ?? null, request_key: o.request_key ?? null,
      target_account_id: o.target,
    });
  };

  const needsPerson = async (p: PostRow, mode: Mode, detail: string, extra: Partial<RunRow> = {}) => {
    await store.markFailed(p.id, detail);
    const task_id = await store.openTask({
      client_id: p.client_id, key: "publisher_check_post", post_id: p.id,
      title: "Check the Facebook Page before this post is sent again",
      notes: `${detail} The publisher will not re-send it or record it on its own. Look at the Page and at the post in Zernio: if it is on the Page, use Mark published on ${postLink(p)} with its link; if it is not, schedule it again. post_id=${p.id}`,
    });
    await zrun(p, mode, { outcome: "ambiguous", detail, task_id, ...extra });
  };

  // Zernio's platform result for our Page → Compass.
  async function applyState(p: PostRow, mode: Mode, postId: string, state: PostState, o: { key: string | null; target: string; http_status?: number | null; prefix?: string }) {
    const base = { provider_post_id: postId, request_key: o.key, target_account_id: o.target, http_status: o.http_status ?? null };
    const pre = o.prefix ? `${o.prefix} ` : "";
    if (state.state === "published") {
      await store.markPublished(p.id, {
        external_post_id: state.platformPostId, published_url: state.platformPostUrl, published_at: state.publishedAt ?? at.toISOString(),
      });
      await zrun(p, mode, { outcome: o.prefix ? "reconciled" : "published", provider_status: state.zernioStatus, detail: `${pre}${state.platformPostUrl}`, ...base });
      await ctx.resolve({ keys: POST_TASK_KEYS, client_id: p.client_id, post_id: p.id }, `published on Facebook: ${state.platformPostUrl}`);
    } else if (state.state === "pending") {
      await zrun(p, mode, { outcome: "submitted", provider_status: state.zernioStatus, detail: `${pre}Zernio accepted it (${state.zernioStatus}); waiting for Facebook's result.`, ...base });
    } else if (state.state === "failed") {
      if (state.needs === "reconnect") await reconnectTask(p.client_id, state.message);
      await failure(p, mode, { detail: state.message, transient: state.transient, provider_post_id: postId, provider_status: state.zernioStatus, request_key: o.key, target: o.target, http_status: o.http_status });
    } else {
      await needsPerson(p, mode, `Zernio's post ${postId} has no Facebook entry for the bound account.`, base);
    }
  }

  // Sends one create (after a write-ahead run, so a cut-off run is still
  // seen as "sent without an answer") and records what came back.
  async function send(p: PostRow, mode: Mode, g: { snap: FacebookSnapshot; binding: Binding; z: ZernioPublisher }, generation: number, mediaUrl: string | null) {
    const target = g.binding.publish_account_id!;
    const key = idempotencyKey(p.publish_key!, generation);
    const body = buildCreateBody(g.snap, g.binding, mediaUrl);
    await zrun(p, mode, { outcome: "uncertain", detail: "Sent to Zernio; waiting for its answer.", request_key: key, provider_media_url: mediaUrl, target_account_id: target });
    const a = await g.z.createPost(body, key);
    const out = interpretCreate(a, target);
    const base = { request_key: key, target_account_id: target, http_status: a.status };
    switch (out.kind) {
      case "result":
        return applyState(p, mode, out.postId, out.state, { key, target, http_status: a.status });
      case "duplicate": {
        const r = await g.z.getPost(out.existingPostId);
        const existing = (r.json as { post?: ZPost } | null)?.post;
        if (r.ok && sameContent(existing, body.content, target)) {
          return applyState(p, mode, out.existingPostId, interpretPost(existing, target), { key, target, http_status: a.status, prefix: "Zernio already had this exact post;" });
        }
        return needsPerson(p, mode, `Zernio refused the post as a duplicate of ${out.existingPostId}, which is not this exact post on this Page.`, base);
      }
      case "in_progress":
        return zrun(p, mode, { outcome: "uncertain", detail: out.message, ...base });
      case "disconnected":
        await reconnectTask(p.client_id, out.message);
        return failure(p, mode, { detail: out.message, transient: false, ...base, target });
      case "unauthorized":
        await connectTask(p.client_id, out.message);
        return failure(p, mode, { detail: out.message, transient: false, ...base, target });
      case "rejected":
        return failure(p, mode, { detail: out.message, transient: false, ...base, target });
      case "transient":
        // No answer at all: it may have been created. Stay publishing; the
        // sweep sends the same key again (Zernio returns the original).
        if (a.status === 0) return zrun(p, mode, { outcome: "uncertain", detail: `${out.message} Checked again with the same key on a later run.`, ...base });
        return failure(p, mode, { detail: out.message, transient: true, ...base, target });
    }
  }

  async function upload(p: PostRow, mode: Mode, z: ZernioPublisher, m: Media, target: string): Promise<string | null> {
    const ext = IMAGE_TYPES[m.type];
    const ps = await z.presign({ filename: `compass-${p.id}-${m.hash.slice(0, 16)}.${ext}`, contentType: m.type, size: m.bytes.length });
    const j = ps.json as { uploadUrl?: string; publicUrl?: string } | null;
    if (!ps.ok || !j?.uploadUrl || !j?.publicUrl || !/^https:\/\//i.test(j.publicUrl)) {
      if (ps.status === 401) await connectTask(p.client_id, ps.message);
      const transient = ps.status === 0 || ps.status === 429 || ps.status >= 500 || (ps.ok && !j?.publicUrl);
      await failure(p, mode, { detail: `Could not get an upload link from Zernio: ${ps.message || "no link in the answer"}`, transient, http_status: ps.status, target });
      return null;
    }
    const up = await z.upload(j.uploadUrl, m.bytes, m.type);
    if (!up.ok) {
      await failure(p, mode, { detail: `The image upload to Zernio failed: ${up.message}`, transient: true, http_status: up.status, target });
      return null;
    }
    return j.publicUrl;
  }

  // A due post (tick) or the one post a person asked to publish now.
  // Returns true when it was claimed.
  async function publish(p: PostRow, mode: Mode): Promise<boolean> {
    const g = await gates(p, mode);
    if (!g) return false;
    if (!p.publish_key) { await blockOnce(p, mode, "The post has no publish key; reopen and approve it again."); return false; }
    const c = await store.claim(p.id);
    if (!c.ok) {
      if (c.error) {
        await store.recheck(p.id);
        await zrun(p, mode, { outcome: "lapsed", detail: c.error });
      }
      return false;
    }
    const row = c.row;
    const target = g.binding.publish_account_id!;
    let plan = planSend(await store.zernioRuns(row.id), row.publish_key!, at);
    if (plan.kind === "person") { await needsPerson(row, mode, plan.detail); return true; }
    if (plan.kind === "check") {
      // Zernio already has a post for this approval: read it before anything is sent.
      const r = await g.z.getPost(plan.postId);
      const state = r.ok ? interpretPost((r.json as { post?: ZPost } | null)?.post, target) : null;
      if (!r.ok && r.status !== 404) {
        await failure(row, mode, { detail: `Could not read Zernio's earlier post before sending again: ${r.message}`, transient: true, http_status: r.status, target });
        return true;
      }
      if (state && state.state !== "failed") {
        if (state.state === "missing") await needsPerson(row, mode, `Zernio's earlier post ${plan.postId} has no entry for this Page.`);
        else await applyState(row, mode, plan.postId, state, { key: idempotencyKey(row.publish_key!, plan.generation), target, prefix: "Already in Zernio; not sent again." });
        return true;
      }
      if (!r.ok) { await needsPerson(row, mode, `Zernio no longer finds its earlier post ${plan.postId}.`); return true; }
      plan = { kind: "send", generation: plan.generation + 1, mediaUrl: null, sameKey: false };
    }
    let mediaUrl = plan.mediaUrl;
    if (g.media && !(plan.sameKey && mediaUrl)) {
      if (plan.sameKey) { await needsPerson(row, mode, "An earlier request has no answer and its image link was not recorded; a re-send could differ."); return true; }
      mediaUrl = await upload(row, mode, g.z, g.media, target);
      if (!mediaUrl) return true;
    }
    await send(row, mode, g, plan.generation, mediaUrl);
    return true;
  }

  // Every tick: in-flight Facebook posts are read back from Zernio; requests
  // without an answer are sent again with the same key; transient failures
  // are rescheduled on the shared backoff.
  async function sweep() {
    for (const p of await store.publishingFacebookPosts()) {
      if (!piloted(p.client_id) || !p.publish_key) continue;
      const snap = (p.approved_snapshot ?? {}) as FacebookSnapshot;
      const binding = await accountOf(snap.social_account_id);
      if (!binding?.publish_account_id) continue;
      const target = binding.publish_account_id;
      const runs = await store.zernioRuns(p.id);
      const stale = !p.last_attempt_at || Date.parse(p.last_attempt_at) <= at.getTime() - STUCK_AFTER_MINUTES * 60_000;
      const plan = planSend(runs, p.publish_key, at);
      const z = await ensureZernio();
      if (!z) continue;
      if (plan.kind === "check") {
        const r = await z.getPost(plan.postId);
        if (r.status === 404) { await needsPerson(p, "sweep", `Zernio no longer finds post ${plan.postId}.`); continue; }
        if (!r.ok) continue; // read again next tick
        const state = interpretPost((r.json as { post?: ZPost } | null)?.post, target);
        if (state.state === "pending") {
          const since = runs.find((x) => x.provider_post_id === plan.postId)?.created_at ?? p.last_attempt_at ?? at.toISOString();
          if (at.getTime() - Date.parse(since) > PENDING_TOO_LONG_HOURS * 3_600_000) {
            await needsPerson(p, "sweep", `Zernio has had post ${plan.postId} pending (${state.zernioStatus}) for over ${PENDING_TOO_LONG_HOURS} hours.`);
          }
          continue;
        }
        await applyState(p, "sweep", plan.postId, state, { key: idempotencyKey(p.publish_key, plan.generation), target, prefix: "Checked in Zernio:" });
        continue;
      }
      if (!stale) continue;
      if (plan.kind === "person") { await needsPerson(p, "sweep", plan.detail); continue; }
      if (!plan.sameKey) {
        // Claimed, but nothing reached Zernio's create (the run was cut off before the request).
        await failure(p, "sweep", { detail: "The last attempt stopped before anything was sent to Zernio. Safe to retry.", transient: true, target });
        continue;
      }
      const hasImage = mediaOf(snap).length > 0;
      if (hasImage && !plan.mediaUrl) { await needsPerson(p, "sweep", "An earlier request has no answer and its image link was not recorded; a re-send could differ."); continue; }
      await send(p, "sweep", { snap, binding, z }, plan.generation, plan.mediaUrl);
    }

    for (const p of await store.failedFacebookPosts()) {
      if (!piloted(p.client_id) || !p.last_attempt_at) continue;
      const last = await store.latestRun(p.id);
      if (!last || last.outcome !== "failed" || !last.transient) continue;
      const due = nextRetryAt(p.last_attempt_at, p.publish_attempts);
      if (!due || due > at) continue;
      if (await store.retry(p.id)) {
        await zrun(p, "retry", { outcome: "retry_scheduled", detail: `Attempt ${p.publish_attempts + 1} of ${MAX_ATTEMPTS}` });
      }
    }
  }

  // ── Read-only: what the publish key sees, matched to Compass's Pages by Page id ──
  async function verifyAccount(z: ZernioPublisher, a: ZernioAccount) {
    const page = await z.facebookPage(a._id);
    const health = await z.health(a._id);
    const pj = (page.json ?? {}) as ZernioFacebookPage;
    return {
      zernio_account_id: a._id,
      name: a.displayName ?? a.username ?? null,
      active: a.isActive !== false && a.enabled !== false && a.needsReconnection !== true,
      selected_page_id: page.ok ? pj.selectedPageId ?? null : null,
      pages: page.ok ? (pj.pages ?? []).map((x) => ({ id: x.id, name: x.name ?? null })) : [],
      page_read: page.ok ? "ok" : page.message,
      health: health.ok ? summarizeHealth(health.json, at) : { status: "unreadable", detail: health.message, checked_at: at.toISOString() },
    };
  }

  async function accountsReport() {
    const z = await ensureZernio();
    if (!z) return { key: { ok: false, detail: keyBlock } };
    const listed = await z.facebookAccounts();
    if (!listed.answer.ok) return { key: { ok: false, detail: listed.answer.message, http_status: listed.answer.status } };
    const zernioAccounts: Awaited<ReturnType<typeof verifyAccount>>[] = [];
    for (const a of listed.accounts) zernioAccounts.push(await verifyAccount(z, a));
    const compass = (await store.facebookAccounts()).map((b) => ({
      social_account_id: b.id, client_id: b.client_id, page_id: b.external_account_id, display_name: b.display_name,
      bound_account_id: b.publish_account_id, enabled: b.publish_enabled, verified_at: b.publish_verified_at,
      // Exact Page-id match only; the binding itself is a separate, explicit call.
      exact_matches: zernioAccounts.filter((x) => !!b.external_account_id && x.selected_page_id === b.external_account_id).map((x) => x.zernio_account_id),
    }));
    return {
      key: { ok: true, secret: ZERNIO_PUBLISH_KEY_SECRET, distinct_from_read_key: true },
      zernio_accounts: zernioAccounts, compass_accounts: compass,
    };
  }

  // Bind one Compass Facebook account to the Zernio account named by the
  // caller, after re-reading it with the publish key. Never enables.
  async function bind(socialAccountId: string, accountId: string) {
    if (!ZERNIO_ACCOUNT_RE.test(accountId)) return { ok: false, status: 400, error: "Not a Zernio account id." };
    const b = await store.account(socialAccountId);
    if (!b || b.platform !== "facebook") return { ok: false, status: 404, error: "No Compass Facebook account with that id." };
    if (!b.external_account_id) return { ok: false, status: 409, error: "The Compass account has no Facebook Page id." };
    const z = await ensureZernio();
    if (!z) return { ok: false, status: 424, error: keyBlock };
    const listed = await z.facebookAccounts();
    if (!listed.answer.ok) return { ok: false, status: 424, error: listed.answer.message };
    const a = listed.accounts.find((x) => x._id === accountId);
    if (!a) return { ok: false, status: 409, error: "The publish key cannot see that Zernio account as a Facebook account." };
    const v = await verifyAccount(z, a);
    const refuse: string[] = [];
    if (!v.active) refuse.push("The Zernio account is not active or needs reconnecting.");
    if (v.selected_page_id !== b.external_account_id) refuse.push(`The Zernio account posts to Page ${v.selected_page_id ?? "(none)"}, not ${b.external_account_id}.`);
    if (!v.pages.some((x) => x.id === b.external_account_id)) refuse.push("The Page is not among the account's Pages.");
    const h = v.health as { status: string; postingGranted?: boolean | null; tokenValid?: boolean | null };
    if (h.status === "error" || h.status === "unreadable" || h.postingGranted === false || h.tokenValid === false) refuse.push(`Zernio health: ${h.status}, posting permission ${h.postingGranted}, token ${h.tokenValid}.`);
    if (refuse.length) return { ok: false, status: 409, error: refuse.join(" "), verified: v };
    const result = await store.bindAccount({ social_account_id: b.id, account_id: accountId, page_id: b.external_account_id, account_name: v.name, health: v.health });
    return { ok: true, status: 200, result, verified: v };
  }

  // ── The no-write preflight ──
  // A real post (post_id) or a fixture built from Compass records. Reads
  // Compass and Zernio (GET only); presigns, uploads, creates and records
  // nothing.
  type Fixture = { client_id: string; social_account_id: string; copy: string; brand_asset_id?: string; creative_asset_id?: string; scheduled_at?: string | null };
  async function preflight(input: { post_id?: string; fixture?: Fixture }) {
    const checks: { gate: string; ok: boolean | null; detail?: string }[] = [];
    const check = (gate: string, ok: boolean | null, detail?: string) => checks.push({ gate, ok, ...(detail ? { detail } : {}) });
    let clientId: string; let snap: FacebookSnapshot; let publishKey: string; let scheduledAt: string | null; let platform: string;
    let post: PostRow | null = null;
    if (input.post_id) {
      post = await store.post(input.post_id);
      if (!post) return { ok: false, error: "No such post." };
      clientId = post.client_id; platform = post.platform; scheduledAt = post.scheduled_at;
      snap = (post.approved_snapshot ?? {}) as FacebookSnapshot;
      publishKey = post.publish_key ?? "(none)";
      const gate = await store.postGate(post.id);
      check("approved", post.review_status === "approved", `review_status ${post.review_status}`);
      check("snapshot hash still valid", gate?.hash_ok ?? false);
      check("grounding still valid", (gate?.grounding_problems ?? ["unreadable"]).length === 0, (gate?.grounding_problems ?? []).join(" ") || undefined);
      check("scheduled or publishable now", ["scheduled", "not_scheduled", "failed"].includes(post.publish_status), `publish_status ${post.publish_status}`);
    } else if (input.fixture) {
      const f = input.fixture;
      clientId = f.client_id; platform = "facebook"; scheduledAt = f.scheduled_at ?? null;
      publishKey = "00000000-0000-4000-8000-00000000f1f7";
      const assets: NonNullable<FacebookSnapshot["assets"]> = [];
      const creative: NonNullable<FacebookSnapshot["creative"]> = [];
      if (f.brand_asset_id) {
        const a = await store.brandAsset(f.brand_asset_id);
        if (!a || a.client_id !== f.client_id) return { ok: false, error: "The brand asset is not this client's." };
        assets.push({ id: a.id, storage_path: a.storage_path, url: null, content_hash: a.content_hash, sort_order: 1 });
      }
      if (f.creative_asset_id) {
        const a = await store.creativeAsset(f.creative_asset_id);
        if (!a || a.client_id !== f.client_id) return { ok: false, error: "The creative asset is not this client's." };
        creative.push({ id: a.id, storage_path: a.storage_path, content_hash: a.content_hash, mime_type: a.mime_type, sort_order: 1 });
      }
      snap = {
        platform: "facebook", social_account_id: f.social_account_id, post_type: "standard", copy: f.copy, cta_type: null, cta_url: null,
        offer: null, assets, ...(creative.length ? { creative } : {}),
      } as FacebookSnapshot;
      check("approved", null, "fixture: not a stored post; the review gate is exercised by the real claim");
      check("snapshot hash still valid", null, "fixture");
      check("grounding still valid", null, "fixture");
    } else return { ok: false, error: "Give post_id or fixture." };

    check("platform facebook", platform === "facebook" && snap.platform === "facebook");
    check("publisher switch on", ctx.settings.enabled, ctx.settings.enabled ? undefined : "off — nothing would be sent");
    check("client on the pilot list", piloted(clientId));
    const problems = facebookProblems(snap);
    check("content publishable on Facebook as approved", problems.length === 0, problems.map((x) => x.message).join(" ") || undefined);
    const binding = await accountOf(snap.social_account_id);
    const bp = bindingProblems({ client_id: clientId, platform, social_account_id: snap.social_account_id ?? null }, binding);
    check("account belongs to the same client", !!binding && binding.client_id === clientId);
    check("verified Zernio binding", !!binding?.publish_account_id && binding.publish_provider === "zernio");
    check("account publishing enabled", !!binding?.publish_enabled);
    check("binding gates", bp.length === 0, bp.join(" ") || undefined);

    const z = await ensureZernio();
    check("publish key readable server-side and distinct from the read key", !!z, keyBlock ?? undefined);
    let live: Record<string, unknown> | null = null;
    if (z && binding?.publish_account_id) {
      const listed = await z.facebookAccounts();
      const a = listed.accounts.find((x) => x._id === binding.publish_account_id);
      if (!listed.answer.ok) check("Zernio account listed", false, listed.answer.message);
      else if (!a) check("Zernio account listed", false, "the publish key does not see the bound account");
      else {
        const v = await verifyAccount(z, a);
        live = v;
        check("Zernio account listed and active", v.active);
        check("Zernio posts to exactly this Page", v.selected_page_id === binding.external_account_id, `selected ${v.selected_page_id}`);
        const h = v.health as { status: string; postingGranted?: boolean | null };
        check("Zernio account healthy with posting permission", h.status !== "error" && h.status !== "unreadable" && h.postingGranted !== false, `health ${h.status}`);
      }
    }

    let media: Record<string, unknown> | null = null;
    const ref = mediaOf(snap)[0];
    if (ref) {
      const m = ref.storage_path && /^[0-9a-f]{64}$/.test(ref.content_hash) ? await loadMedia(ref) : { problem: "no stored file or hash", fix: true };
      media = "problem" in m
        ? { kind: ref.kind, id: ref.id, bucket: ref.bucket, storage_path: ref.storage_path, approved_sha256: ref.content_hash, ok: false, detail: m.problem }
        : { kind: ref.kind, id: ref.id, bucket: ref.bucket, storage_path: ref.storage_path, approved_sha256: ref.content_hash, actual_sha256: m.hash, bytes: m.bytes.length, content_type: m.type, ok: true };
      check("image bytes match the approved hash", media.ok as boolean, (media.detail as string) ?? undefined);
    }

    const placeholder = ref ? "https://media.zernio.com/temp/<uploaded at publish time>" : null;
    const body = binding?.publish_account_id ? buildCreateBody(snap, binding, placeholder) : null;
    const nowKind = !scheduledAt || Date.parse(scheduledAt) <= at.getTime();
    const blocking = checks.filter((c) => c.ok === false);
    return {
      ok: true, writes: false,
      source: input.post_id ? { post_id: input.post_id } : { fixture: true },
      checks, would_publish: blocking.length === 0 && (input.post_id ? true : false),
      blocking: blocking.map((c) => c.gate),
      target: binding ? {
        social_account_id: binding.id, client_id: binding.client_id, facebook_page_id: binding.external_account_id,
        page_name: binding.display_name, zernio_account_id: binding.publish_account_id, zernio_account_name: binding.publish_account_name,
      } : null,
      zernio: live,
      media,
      request: body ? {
        method: "POST", url: `${ZERNIO_BASE}/v1/posts`,
        headers: { Authorization: `Bearer [${ZERNIO_PUBLISH_KEY_SECRET}]`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey(publishKey, 1) },
        body,
        steps: ref ? ["POST /v1/media/presign", "PUT <presigned uploadUrl> (image bytes, no key)", "POST /v1/posts"] : ["POST /v1/posts"],
      } : null,
      exact_copy: snap.copy ?? null,
      timing: nowKind
        ? { kind: "publish_now", detail: "Sent on Publish now or the next 5-minute tick, with publishNow: true." }
        : { kind: "scheduled", scheduled_at: scheduledAt, america_chicago: chicago(scheduledAt!),
            detail: "Compass holds the schedule: the tick that reaches this time claims the post (re-checking approval and grounding) and sends it with publishNow: true." },
    };
  }

  return { routable, publish, sweep, preflight, accountsReport, bind };
}

export type FacebookPath = ReturnType<typeof createFacebookPath>;
export type { Answer };
