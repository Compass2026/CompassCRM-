// The publisher's path through Zernio, shared by every channel it carries
// (docs/zernio-publisher.md): Facebook (facebook-path.ts) and the Business
// Profile (gbp-path.ts). The handler owns the tick; this owns what happens to
// a post routed through Zernio inside it, with the same guarantees as the
// direct Business Profile path:
//
// - Only the approved snapshot is sent: the exact approved copy, the exact
//   image (its bytes re-hashed against the hash the approval bound), to the
//   one Zernio account explicitly bound to the snapshot's destination of the
//   same client, pinned to that destination (a Page id or a location).
// - The claim (0045) re-checks the approval fingerprint and grounding, as for
//   every post; a refusal sends the post back to review.
// - Never a second post: every create carries an Idempotency-Key derived from
//   the approval's publish_key; a request without a definite answer is sent
//   again only with the same key (inside Zernio's window) and the same body,
//   and a post Zernio already has is read before anything is sent again. A
//   409 duplicate is a reason to look, never to post again.
// - The destination of a request in flight is on record (target account and
//   location); a binding changed under it goes to a person.
// - Recorded published only from Zernio's entry for exactly this platform,
//   account (and location) with its live https URL; anything unclear stays
//   `publishing` (submitted / uncertain) and is reconciled on later ticks, or
//   goes to a person.
//
// Also the shared no-write preflight. Each channel adds its own read-only
// verification and binding (accounts, Pages, locations).

import { MAX_ATTEMPTS, nextRetryAt, STUCK_AFTER_MINUTES } from "./channel.ts";
import {
  chicago, idempotencyKey, interpretCreate, interpretPost, mediaOf, PENDING_TOO_LONG_HOURS, planSend, sameContent, sha256Hex, sniffImage,
  targetDrift, ZERNIO_PUBLISH_KEY_SECRET, ZERNIO_READ_KEY_SECRET,
  type Binding, type EntryMatch, type FacebookSnapshot, type MediaRef, type PostState, type ZPost,
} from "./facebook.ts";
import type { PostRow, RunRow, Store } from "./store.ts";
import { createZernioPublisher, ZERNIO_BASE, type ZernioPublisher } from "./zernio.ts";

type Mode = RunRow["mode"];
export type ZernioCtx = {
  store: Store;
  fetch: typeof fetch;
  at: Date;
  settings: { enabled: boolean; clients: string[] };
  run: (r: RunRow) => Promise<void>;
  note: (post_id: string, outcome: string, detail?: string | null) => void;
  resolve: (f: { keys: string[]; client_id?: string; post_id?: string }, why: string) => Promise<void>;
};

export type Snap = FacebookSnapshot;
type Check = { gate: string; ok: boolean | null; detail?: string };

// What differs between channels. Everything else is shared.
export type ZernioChannel = {
  platform: "facebook" | "google_business";
  label: string;
  texts: {
    fixTitle: string;
    failedTitle: string;
    checkTitle: string;
    checkNotes: (detail: string, link: string, postId: string) => string;
    connectTitle: string;
    connectNotes: (why: string) => string;
    reconnectTitle: string;
    reconnectNotes: (why: string) => string;
    publishedOn: string;
    waiting: string;
    noEntry: (postId: string) => string;
    earlierNoEntry: (postId: string) => string;
    duplicateOther: (postId: string) => string;
  };
  problems: (s: Snap) => { message: string }[];
  bindingProblems: (post: { client_id: string; platform: string; social_account_id: string | null }, b: Binding | null) => string[];
  target: (b: Binding) => { accountId: string; locationId: string | null };
  match: (b: Binding) => EntryMatch;
  body: (s: Snap, b: Binding, mediaUrl: string | null) => { content: string };
  imageProblem: (bytes: Uint8Array, type: string | null) => string | null;
  // Posts of this channel the sweep reads back / retries, and whether a post
  // is this path's (a Business Profile post may be on the direct path).
  publishing: () => Promise<PostRow[]>;
  failed: () => Promise<PostRow[]>;
  owns: (p: PostRow) => Promise<boolean>;
  // An earlier attempt by another transport that has no settled result: the
  // post is not sent through Zernio until it is resolved.
  priorExecution?: (p: PostRow) => Promise<string | null>;
  // Preflight: the destination as shown, and the live read-only checks.
  targetView: (b: Binding) => Record<string, unknown>;
  live: (z: ZernioPublisher, b: Binding, check: (gate: string, ok: boolean | null, detail?: string) => void) => Promise<Record<string, unknown> | null>;
  fixture: (f: Fixture, media: { assets: NonNullable<Snap["assets"]>; creative: NonNullable<Snap["creative"]> }) => Snap;
};

export type Fixture = {
  client_id: string; social_account_id: string; copy: string; brand_asset_id?: string; creative_asset_id?: string; scheduled_at?: string | null;
  platform?: string; cta_type?: string | null; cta_url?: string | null; post_type?: string;
};

const POST_TASK_KEYS = ["publisher_fix_post", "publisher_failed", "publisher_check_post"];
const Z = "zernio" as const;

type Media = { ref: MediaRef; bytes: Uint8Array; type: string; hash: string };

export function createZernioPath(ctx: ZernioCtx, ch: ZernioChannel) {
  const { store, at } = ctx;
  const T = ch.texts;
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
  const targetFields = (b: Binding) => {
    const t = ch.target(b);
    return { target_account_id: t.accountId, ...(t.locationId ? { target_location_id: t.locationId } : {}) };
  };

  // A block the post already sits on is not logged again every tick.
  const blockOnce = async (p: PostRow, mode: Mode, detail: string, task_id: string | null = null) => {
    const last = await store.latestRun(p.id);
    if (last?.outcome === "blocked" && last.detail === detail) { ctx.note(p.id, "blocked", detail); return; }
    await zrun(p, mode, { outcome: "blocked", detail, task_id });
  };

  // Would the publisher send this post through Zernio? Read from the live
  // row; the snapshot decides at send time.
  async function routable(p: PostRow): Promise<boolean> {
    if (p.platform !== ch.platform || !ctx.settings.enabled || !piloted(p.client_id)) return false;
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
    const problem = ch.imageProblem(d.bytes, type);
    if (problem) return { problem, fix: true };
    return { ref, bytes: d.bytes, type: type!, hash };
  }

  const fixPost = async (p: PostRow, mode: Mode, detail: string) => {
    if (p.publish_status === "scheduled") await store.unschedule(p.id);
    const task_id = await store.openTask({
      client_id: p.client_id, key: "publisher_fix_post", post_id: p.id,
      title: T.fixTitle,
      notes: `${detail} Reopen the post, fix it, get it approved and schedule it again: ${postLink(p)}. post_id=${p.id}`,
    });
    await zrun(p, mode, { outcome: "blocked", detail, task_id });
  };

  const connectTask = (clientId: string, why: string) => store.openTask({
    client_id: clientId, key: "publisher_connect_zernio", title: T.connectTitle, notes: T.connectNotes(why),
  });
  const reconnectTask = (clientId: string, why: string) => store.openTask({
    client_id: clientId, key: "publisher_reconnect_zernio", title: T.reconnectTitle, notes: T.reconnectNotes(why),
  });

  // Everything that can be checked before the claim, without writing to Zernio.
  async function gates(p: PostRow, mode: Mode): Promise<{ snap: Snap; binding: Binding; media: Media | null; z: ZernioPublisher } | null> {
    if (!piloted(p.client_id)) {
      await blockOnce(p, mode, "This client is not on the publisher's pilot list (Settings → Publisher).");
      return null;
    }
    const snap = (p.approved_snapshot ?? {}) as Snap;
    const problems = ch.problems(snap);
    if (problems.length) {
      await fixPost(p, mode, `Not publishable as approved: ${problems.map((x) => x.message).join(" ")}`);
      return null;
    }
    const binding = await accountOf(snap.social_account_id);
    const bp = ch.bindingProblems({ client_id: p.client_id, platform: p.platform, social_account_id: snap.social_account_id ?? null }, binding);
    if (bp.length) {
      const unbound = !binding || !binding.publish_account_id;
      const task_id = unbound && binding?.client_id === p.client_id ? await connectTask(p.client_id, bp.join(" ")) : null;
      await blockOnce(p, mode, bp.join(" "), task_id);
      return null;
    }
    const prior = ch.priorExecution ? await ch.priorExecution(p) : null;
    if (prior) {
      await blockOnce(p, mode, prior);
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

  type Target = { target_account_id: string; target_location_id?: string };
  const failure = async (p: PostRow, mode: Mode, o: { detail: string; transient: boolean; http_status?: number | null; provider_post_id?: string | null; provider_status?: string | null; request_key?: string | null; target: Target }) => {
    await store.markFailed(p.id, o.detail);
    const final = !o.transient || p.publish_attempts >= MAX_ATTEMPTS;
    let task_id: string | null = null;
    if (final) {
      task_id = await store.openTask({
        client_id: p.client_id, key: "publisher_failed", post_id: p.id,
        title: T.failedTitle,
        notes: `${o.detail} (attempt ${p.publish_attempts} of ${MAX_ATTEMPTS}${o.transient ? "" : "; not retried automatically"}). Open ${postLink(p)}. post_id=${p.id}`,
      });
    }
    await zrun(p, mode, {
      outcome: "failed", transient: o.transient, http_status: o.http_status ?? null, detail: o.detail, task_id,
      provider_post_id: o.provider_post_id ?? null, provider_status: o.provider_status ?? null, request_key: o.request_key ?? null,
      ...o.target,
    });
  };

  const needsPerson = async (p: PostRow, mode: Mode, detail: string, extra: Partial<RunRow> = {}) => {
    await store.markFailed(p.id, detail);
    const task_id = await store.openTask({
      client_id: p.client_id, key: "publisher_check_post", post_id: p.id,
      title: T.checkTitle,
      notes: T.checkNotes(detail, postLink(p), p.id),
    });
    await zrun(p, mode, { outcome: "ambiguous", detail, task_id, ...extra });
  };

  // Zernio's platform result for our destination → Compass.
  async function applyState(p: PostRow, mode: Mode, postId: string, state: PostState, o: { key: string | null; target: Target; http_status?: number | null; prefix?: string }) {
    const base = { provider_post_id: postId, request_key: o.key, http_status: o.http_status ?? null, ...o.target };
    const pre = o.prefix ? `${o.prefix} ` : "";
    if (state.state === "published") {
      await store.markPublished(p.id, {
        external_post_id: state.platformPostId, published_url: state.platformPostUrl, published_at: state.publishedAt ?? at.toISOString(),
      });
      await zrun(p, mode, { outcome: o.prefix ? "reconciled" : "published", provider_status: state.zernioStatus, detail: `${pre}${state.platformPostUrl}`, ...base });
      await ctx.resolve({ keys: POST_TASK_KEYS, client_id: p.client_id, post_id: p.id }, `${T.publishedOn}: ${state.platformPostUrl}`);
    } else if (state.state === "pending") {
      await zrun(p, mode, { outcome: "submitted", provider_status: state.zernioStatus, detail: `${pre}Zernio accepted it (${state.zernioStatus}); ${T.waiting}`, ...base });
    } else if (state.state === "failed") {
      if (state.needs === "reconnect") await reconnectTask(p.client_id, state.message);
      await failure(p, mode, { detail: state.message, transient: state.transient, provider_post_id: postId, provider_status: state.zernioStatus, request_key: o.key, target: o.target, http_status: o.http_status });
    } else {
      await needsPerson(p, mode, T.noEntry(postId), base);
    }
  }

  // Sends one create (after a write-ahead run, so a cut-off run is still
  // seen as "sent without an answer") and records what came back.
  async function send(p: PostRow, mode: Mode, g: { snap: Snap; binding: Binding; z: ZernioPublisher }, generation: number, mediaUrl: string | null) {
    const target = targetFields(g.binding);
    const account = target.target_account_id;
    const m = ch.match(g.binding);
    const key = idempotencyKey(p.publish_key!, generation);
    const body = ch.body(g.snap, g.binding, mediaUrl);
    await zrun(p, mode, { outcome: "uncertain", detail: "Sent to Zernio; waiting for its answer.", request_key: key, provider_media_url: mediaUrl, ...target });
    const a = await g.z.createPost(body, key);
    const out = interpretCreate(a, account, m);
    const base = { request_key: key, http_status: a.status, ...target };
    switch (out.kind) {
      case "result":
        return applyState(p, mode, out.postId, out.state, { key, target, http_status: a.status });
      case "duplicate": {
        const r = await g.z.getPost(out.existingPostId);
        const existing = (r.json as { post?: ZPost } | null)?.post;
        if (r.ok && sameContent(existing, body.content, account, m)) {
          return applyState(p, mode, out.existingPostId, interpretPost(existing, account, m), { key, target, http_status: a.status, prefix: "Zernio already had this exact post;" });
        }
        return needsPerson(p, mode, T.duplicateOther(out.existingPostId), base);
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

  async function upload(p: PostRow, mode: Mode, z: ZernioPublisher, m: Media, target: Target): Promise<string | null> {
    const ext = m.type.split("/")[1] === "jpeg" ? "jpg" : m.type.split("/")[1];
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
    const target = targetFields(g.binding);
    const account = target.target_account_id;
    const m = ch.match(g.binding);
    const runs = await store.zernioRuns(row.id);
    const drift = targetDrift(runs, row.publish_key!, ch.target(g.binding));
    if (drift) { await needsPerson(row, mode, drift); return true; }
    let plan = planSend(runs, row.publish_key!, at);
    if (plan.kind === "person") { await needsPerson(row, mode, plan.detail); return true; }
    if (plan.kind === "check") {
      // Zernio already has a post for this approval: read it before anything is sent.
      const r = await g.z.getPost(plan.postId);
      const state = r.ok ? interpretPost((r.json as { post?: ZPost } | null)?.post, account, m) : null;
      if (!r.ok && r.status !== 404) {
        await failure(row, mode, { detail: `Could not read Zernio's earlier post before sending again: ${r.message}`, transient: true, http_status: r.status, target });
        return true;
      }
      if (state && state.state !== "failed") {
        if (state.state === "missing") await needsPerson(row, mode, T.earlierNoEntry(plan.postId));
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

  // Every tick: in-flight posts are read back from Zernio; requests without
  // an answer are sent again with the same key; transient failures are
  // rescheduled on the shared backoff.
  async function sweep() {
    for (const p of await ch.publishing()) {
      if (!piloted(p.client_id) || !p.publish_key || !(await ch.owns(p))) continue;
      const snap = (p.approved_snapshot ?? {}) as Snap;
      const binding = await accountOf(snap.social_account_id);
      if (!binding?.publish_account_id) continue;
      const target = targetFields(binding);
      const account = target.target_account_id;
      const m = ch.match(binding);
      const runs = await store.zernioRuns(p.id);
      const stale = !p.last_attempt_at || Date.parse(p.last_attempt_at) <= at.getTime() - STUCK_AFTER_MINUTES * 60_000;
      const drift = targetDrift(runs, p.publish_key, ch.target(binding));
      if (drift) { await needsPerson(p, "sweep", drift); continue; }
      const plan = planSend(runs, p.publish_key, at);
      const z = await ensureZernio();
      if (!z) continue;
      if (plan.kind === "check") {
        const r = await z.getPost(plan.postId);
        if (r.status === 404) { await needsPerson(p, "sweep", `Zernio no longer finds post ${plan.postId}.`); continue; }
        if (!r.ok) continue; // read again next tick
        const state = interpretPost((r.json as { post?: ZPost } | null)?.post, account, m);
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

    for (const p of await ch.failed()) {
      if (!piloted(p.client_id) || !p.last_attempt_at || !(await ch.owns(p))) continue;
      const last = await store.latestRun(p.id);
      if (!last || last.outcome !== "failed" || !last.transient) continue;
      const due = nextRetryAt(p.last_attempt_at, p.publish_attempts);
      if (!due || due > at) continue;
      if (await store.retry(p.id)) {
        await zrun(p, "retry", { outcome: "retry_scheduled", detail: `Attempt ${p.publish_attempts + 1} of ${MAX_ATTEMPTS}` });
      }
    }
  }

  // ── The no-write preflight ──
  // A real post (post_id) or a fixture built from Compass records. Reads
  // Compass and Zernio (GET only); presigns, uploads, creates and records
  // nothing.
  async function preflight(input: { post_id?: string; fixture?: Fixture }) {
    const checks: Check[] = [];
    const check = (gate: string, ok: boolean | null, detail?: string) => checks.push({ gate, ok, ...(detail ? { detail } : {}) });
    let clientId: string; let snap: Snap; let publishKey: string; let scheduledAt: string | null; let platform: string;
    let post: PostRow | null = null;
    if (input.post_id) {
      post = await store.post(input.post_id);
      if (!post) return { ok: false, error: "No such post." };
      clientId = post.client_id; platform = post.platform; scheduledAt = post.scheduled_at;
      snap = (post.approved_snapshot ?? {}) as Snap;
      publishKey = post.publish_key ?? "(none)";
      const gate = await store.postGate(post.id);
      check("approved", post.review_status === "approved", `review_status ${post.review_status}`);
      check("snapshot hash still valid", gate?.hash_ok ?? false);
      check("grounding still valid", (gate?.grounding_problems ?? ["unreadable"]).length === 0, (gate?.grounding_problems ?? []).join(" ") || undefined);
      check("scheduled or publishable now", ["scheduled", "not_scheduled", "failed"].includes(post.publish_status), `publish_status ${post.publish_status}`);
    } else if (input.fixture) {
      const f = input.fixture;
      clientId = f.client_id; platform = ch.platform; scheduledAt = f.scheduled_at ?? null;
      publishKey = "00000000-0000-4000-8000-00000000f1f7";
      const assets: NonNullable<Snap["assets"]> = [];
      const creative: NonNullable<Snap["creative"]> = [];
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
      snap = ch.fixture(f, { assets, creative });
      check("approved", null, "fixture: not a stored post; the review gate is exercised by the real claim");
      check("snapshot hash still valid", null, "fixture");
      check("grounding still valid", null, "fixture");
    } else return { ok: false, error: "Give post_id or fixture." };

    const zernioPlatform = ch.platform === "google_business" ? "google_business" : "facebook";
    check(`platform ${zernioPlatform}`, platform === ch.platform && snap.platform === ch.platform);
    check("publisher switch on", ctx.settings.enabled, ctx.settings.enabled ? undefined : "off — nothing would be sent");
    check("client on the pilot list", piloted(clientId));
    const problems = ch.problems(snap);
    check(`content publishable on ${ch.label} as approved`, problems.length === 0, problems.map((x) => x.message).join(" ") || undefined);
    const binding = await accountOf(snap.social_account_id);
    const bp = ch.bindingProblems({ client_id: clientId, platform, social_account_id: snap.social_account_id ?? null }, binding);
    check("account belongs to the same client", !!binding && binding.client_id === clientId);
    check("verified Zernio binding", !!binding?.publish_account_id && binding.publish_provider === "zernio");
    check("account publishing enabled", !!binding?.publish_enabled);
    check("binding gates", bp.length === 0, bp.join(" ") || undefined);
    if (post && ch.priorExecution) {
      const prior = await ch.priorExecution(post);
      check("no unsettled attempt by another transport", !prior, prior ?? undefined);
    }

    const z = await ensureZernio();
    check("publish key readable server-side and distinct from the read key", !!z, keyBlock ?? undefined);
    let live: Record<string, unknown> | null = null;
    if (z && binding?.publish_account_id) live = await ch.live(z, binding, check);

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
    const body = binding?.publish_account_id ? ch.body(snap, binding, placeholder) : null;
    const nowKind = !scheduledAt || Date.parse(scheduledAt) <= at.getTime();
    const blocking = checks.filter((c) => c.ok === false);
    return {
      ok: true, writes: false,
      source: input.post_id ? { post_id: input.post_id } : { fixture: true },
      checks, would_publish: blocking.length === 0 && (input.post_id ? true : false),
      blocking: blocking.map((c) => c.gate),
      target: binding ? ch.targetView(binding) : null,
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

  return { routable, publish, sweep, preflight, ensureZernio, keyBlock: () => keyBlock, accountOf };
}

export type ZernioPath = ReturnType<typeof createZernioPath>;
