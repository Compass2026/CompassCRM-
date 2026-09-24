// post-publisher — publishes approved, scheduled Business Profile posts
// (0045 / 0046). One governed path for the 5-minute tick and for a person's
// "Publish now": preflight → claim (0045 re-checks the approval fingerprint
// and grounding) → build from the approved snapshot → check Google before any
// re-send → send → record. Every outcome, including a preflight block, is a
// publisher_runs row; blocks that need a person open one TOM task.
//
// Callers: the cron tick (x-cron-secret), or a signed-in team member with
// { mode: "now", post_id } (the app's Publish now). Nothing else is accepted,
// and no caller can hand it text to publish: it only ever reads the post's
// approved_snapshot.
//
// Also, every tick: a non-Business-Profile post whose scheduled time has come
// gets a TOM "post this by hand" task (the publisher never posts those), and
// the task closes itself once the post is marked published.

import {
  buildLocalPost,
  channelProblems,
  findExistingPost,
  isTransient,
  MAX_ATTEMPTS,
  MAX_POSTS_PER_TICK,
  nextRetryAt,
  SIGNED_URL_SECONDS,
  STUCK_AFTER_MINUTES,
  type Snapshot,
} from "./channel.ts";
import { googleClient, googleMessage, refreshToken, type Location } from "./google.ts";
import type { PostRow, RunRow, Store } from "./store.ts";

type Fetch = typeof fetch;
export type Deps = { store: Store; fetch: Fetch; now?: () => Date; googleTimeoutMs?: number };
type Mode = "tick" | "now";
export type TickReport = { mode: Mode; enabled: boolean; results: { post_id: string; outcome: string; detail?: string | null }[] };

const PLATFORM_LABEL: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", x: "X", tiktok: "TikTok",
};

export function createPostPublisher(deps: Deps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  async function tick(opts: { mode: Mode; postId?: string }): Promise<TickReport> {
    const at = now();
    const report: TickReport = { mode: opts.mode, enabled: false, results: [] };
    const note = (post_id: string, outcome: string, detail?: string | null) => report.results.push({ post_id, outcome, detail });

    const run = async (r: RunRow) => {
      await store.insertRun(r);
      note(r.post_id, r.outcome, r.detail ?? null);
    };
    // A block the post is already sitting on is not logged again every tick.
    const blockOnce = async (p: PostRow, mode: RunRow["mode"], detail: string, task_id: string | null = null) => {
      const last = await store.latestRun(p.id);
      if (last?.outcome === "blocked" && last.detail === detail) { note(p.id, "blocked", detail); return; }
      await run({ post_id: p.id, client_id: p.client_id, mode, outcome: "blocked", detail, task_id });
    };
    const postLink = (p: PostRow) => `/clients/${p.client_id}/social/${p.id}`;

    // ── Hand-publishing reminders (non-Business-Profile posts) ──
    if (opts.mode === "tick") {
      for (const r of await store.openReminders()) {
        if (await store.hasClosedReminder(r.post_id)) continue;
        const p = await store.post(r.post_id);
        const done = !p || p.publish_status === "published";
        const gone = p && p.publish_status !== "scheduled" && p.publish_status !== "published";
        if (done || gone) {
          if (r.task_id) await store.closeTask(r.task_id, done ? "Marked published." : "No longer scheduled.");
          await run({ post_id: r.post_id, client_id: r.client_id, mode: "reminder", outcome: "reminder_closed",
            detail: done ? "Marked published" : "No longer scheduled", task_id: r.task_id });
        }
      }
      for (const p of await store.dueHandPosts(at.toISOString())) {
        if (await store.hasReminder(p.id)) continue;
        const label = PLATFORM_LABEL[p.platform] ?? p.platform;
        const task_id = await store.openTask({
          client_id: p.client_id, key: "post_by_hand", post_id: p.id,
          title: `Post this by hand: ${label} — ${(p.copy ?? "").trim().slice(0, 60)}`,
          notes: `Scheduled for ${p.scheduled_at}. Publish it on ${label} yourself, then use Mark published on ${postLink(p)}. post_id=${p.id}`,
        });
        await run({ post_id: p.id, client_id: p.client_id, mode: "reminder", outcome: "reminder_opened",
          detail: `${label} post due ${p.scheduled_at}`, task_id });
      }
    }

    // ── Switch and pilot list ──
    const settings = await store.settings();
    report.enabled = settings.enabled;
    if (!settings.enabled) {
      if (opts.postId) {
        const p = await store.post(opts.postId);
        if (p) await blockOnce(p, "now", "The publisher is switched off (Settings → Publisher).");
      }
      return report;
    }
    const piloted = (clientId: string) => settings.clients.includes(clientId);

    // ── Google, lazily, once per run ──
    let google: ReturnType<typeof googleClient> | null = null;
    let googleBlock: string | null = null;
    const ensureGoogle = async () => {
      if (google || googleBlock) return;
      const clientId = (await store.secret("GOOGLE_OPS_CLIENT_ID")) ?? (await store.secret("GSC_CLIENT_ID"));
      const clientSecret = (await store.secret("GOOGLE_OPS_CLIENT_SECRET")) ?? (await store.secret("GSC_CLIENT_SECRET"));
      const refresh = await store.secret("GOOGLE_OPS_REFRESH_TOKEN");
      const t = await refreshToken(deps.fetch, { clientId, clientSecret, refreshToken: refresh }, deps.googleTimeoutMs);
      if ("blocked" in t) googleBlock = t.blocked;
      else google = googleClient(deps.fetch, t.token, deps.googleTimeoutMs);
    };
    const locations = new Map<string, { loc: Location } | { blocked: string }>();
    const locationFor = async (clientId: string) => {
      if (!locations.has(clientId)) {
        const client = await store.client(clientId);
        if (!client) { locations.set(clientId, { blocked: "Client not found." }); }
        else {
          const r = await google!.locate(client);
          if ("blocked" in r) locations.set(clientId, r);
          else {
            if (r.found) await store.setGbpLocation(clientId, `${r.loc.account}/${r.loc.location}`);
            locations.set(clientId, { loc: r.loc });
          }
        }
      }
      return locations.get(clientId)!;
    };

    // Preflight shared by every path. Returns the location, or null after
    // recording the block (and opening the TOM task when a person must act).
    const preflight = async (p: PostRow, mode: RunRow["mode"]): Promise<Location | null> => {
      if (p.platform !== "google_business") {
        await blockOnce(p, mode, "Only Business Profile posts are published by the publisher; mark this one published by hand.");
        return null;
      }
      if (!piloted(p.client_id)) {
        await blockOnce(p, mode, "This client is not on the publisher's pilot list (Settings → Publisher).");
        return null;
      }
      const problems = channelProblems((p.approved_snapshot ?? {}) as Snapshot);
      if (problems.length) {
        const detail = `Not publishable as approved: ${problems.map((x) => x.message).join(" ")}`;
        if (p.publish_status === "scheduled") await store.unschedule(p.id);
        const task_id = await store.openTask({
          client_id: p.client_id, key: "publisher_fix_post", post_id: p.id,
          title: "Fix a Business Profile post before it can publish",
          notes: `${detail} Reopen the post, fix it, get it approved and schedule it again: ${postLink(p)}. post_id=${p.id}`,
        });
        await run({ post_id: p.id, client_id: p.client_id, mode, outcome: "blocked", detail, task_id });
        return null;
      }
      await ensureGoogle();
      if (googleBlock) {
        const task_id = await store.openTask({
          client_id: p.client_id, key: "publisher_connect_google",
          title: "Connect Google so Business Profile posts can publish",
          notes: `${googleBlock} Posts stay scheduled and publish on the next run after it is fixed.`,
        });
        await blockOnce(p, mode, googleBlock, task_id);
        return null;
      }
      const l = await locationFor(p.client_id);
      if ("blocked" in l) {
        const task_id = await store.openTask({
          client_id: p.client_id, key: "publisher_profile_access",
          title: "Give Compass manager access to the client's Business Profile",
          notes: `${l.blocked} Posts stay scheduled and publish on the next run after access is granted.`,
        });
        await blockOnce(p, mode, l.blocked, task_id);
        return null;
      }
      return l.loc;
    };

    const finishFailure = async (p: PostRow, mode: RunRow["mode"], attempts: number, status: number | null, detail: string) => {
      await store.markFailed(p.id, detail);
      const transient = isTransient(status);
      const final = !transient || attempts >= MAX_ATTEMPTS;
      let task_id: string | null = null;
      if (final) {
        task_id = await store.openTask({
          client_id: p.client_id, key: "publisher_failed", post_id: p.id,
          title: "A Business Profile post failed to publish",
          notes: `${detail} (attempt ${attempts} of ${MAX_ATTEMPTS}${transient ? "" : "; not retried automatically"}). Open ${postLink(p)}. post_id=${p.id}`,
        });
      }
      await run({ post_id: p.id, client_id: p.client_id, mode, outcome: "failed", transient, http_status: status, detail, task_id });
    };

    // ── Stuck: publishing with no answer recorded ──
    if (opts.mode === "tick") {
      const before = new Date(at.getTime() - STUCK_AFTER_MINUTES * 60_000).toISOString();
      for (const p of await store.stuckGbpPosts(before)) {
        if (!piloted(p.client_id)) continue;
        await ensureGoogle();
        if (googleBlock) continue;
        const l = await locationFor(p.client_id);
        if ("blocked" in l) continue;
        const listed = await google!.listPosts(l.loc);
        if (!listed.ok) continue; // try again next tick
        const found = findExistingPost(listed.posts, (p.approved_snapshot as Snapshot | null)?.copy ?? p.copy, p.last_attempt_at);
        if (found) {
          await store.markPublished(p.id, {
            external_post_id: found.name,
            published_url: found.searchUrl ?? l.loc.mapsUri ?? `https://mybusiness.googleapis.com/v4/${found.name}`,
            published_at: found.createTime ?? at.toISOString(),
          });
          await run({ post_id: p.id, client_id: p.client_id, mode: "sweep", outcome: "reconciled", detail: `Found on Google as ${found.name}` });
        } else {
          await finishFailure(p, "sweep", p.publish_attempts, null, "No confirmation from Google for the last attempt; nothing was found on the profile. Safe to retry.");
        }
      }

      // ── Automatic retries: transient failures, under the cap, after backoff ──
      for (const p of await store.failedGbpPosts()) {
        if (!piloted(p.client_id) || !p.last_attempt_at) continue;
        const last = await store.latestRun(p.id);
        if (!last || last.outcome !== "failed" || !last.transient) continue;
        const due = nextRetryAt(p.last_attempt_at, p.publish_attempts);
        if (!due || due > at) continue;
        if (await store.retry(p.id)) {
          await run({ post_id: p.id, client_id: p.client_id, mode: "retry", outcome: "retry_scheduled",
            detail: `Attempt ${p.publish_attempts + 1} of ${MAX_ATTEMPTS}` });
        }
      }
    }

    // ── Due posts (or the one post a person asked to publish now) ──
    let queue: PostRow[];
    if (opts.postId) {
      const p = await store.post(opts.postId);
      queue = p && p.publish_status === "scheduled" ? [p] : [];
      if (p && p.publish_status !== "scheduled") note(p.id, "skipped", `The post is ${p.publish_status}.`);
    } else {
      queue = await store.dueGbpPosts(at.toISOString(), MAX_POSTS_PER_TICK * 4);
    }
    const usedLocations = new Set<string>();
    let claimed = 0;
    for (const p of queue) {
      if (claimed >= MAX_POSTS_PER_TICK) break;
      const mode: RunRow["mode"] = opts.mode === "now" ? "now" : "tick";
      const loc = await preflight(p, mode);
      if (!loc) continue;
      const locKey = `${loc.account}/${loc.location}`;
      if (usedLocations.has(locKey)) continue; // one post per location per run
      const previousAttemptAt = p.last_attempt_at;

      const c = await store.claim(p.id);
      if (!c.ok) {
        if (c.error) {
          // 0045 refused the claim: what the approval stood on changed.
          await store.recheck(p.id);
          await run({ post_id: p.id, client_id: p.client_id, mode, outcome: "lapsed", detail: c.error });
        }
        continue;
      }
      claimed++;
      usedLocations.add(locKey);
      const row = c.row;
      const snap = (row.approved_snapshot ?? {}) as Snapshot;

      // An earlier attempt may have reached Google without an answer: look
      // before sending again.
      if (row.publish_attempts > 1 && previousAttemptAt) {
        const listed = await google!.listPosts(loc);
        if (!listed.ok) {
          await finishFailure(row, mode, row.publish_attempts, listed.answer.status, `Could not check Google before re-sending: ${googleMessage(listed.answer)}`);
          continue;
        }
        const found = findExistingPost(listed.posts, snap.copy, previousAttemptAt);
        if (found) {
          await store.markPublished(row.id, {
            external_post_id: found.name,
            published_url: found.searchUrl ?? loc.mapsUri ?? `https://mybusiness.googleapis.com/v4/${found.name}`,
            published_at: found.createTime ?? at.toISOString(),
          });
          await run({ post_id: row.id, client_id: row.client_id, mode, outcome: "reconciled", detail: `Already on Google as ${found.name}; not sent again` });
          continue;
        }
      }

      let photoUrl: string | null = null;
      const asset = (snap.assets ?? [])[0];
      if (asset) {
        photoUrl = asset.storage_path ? await store.signPhoto(asset.storage_path, SIGNED_URL_SECONDS) : asset.url;
        if (!photoUrl) {
          await finishFailure(row, mode, row.publish_attempts, null, "Could not create a link to the photo in storage.");
          continue;
        }
      }

      const answer = await google!.createPost(loc, buildLocalPost(snap, photoUrl));
      if (answer.ok) {
        const created = answer.json as { name?: string; searchUrl?: string; createTime?: string } | null;
        const name = created?.name ?? "";
        await store.markPublished(row.id, {
          external_post_id: name,
          published_url: created?.searchUrl ?? loc.mapsUri ?? `https://mybusiness.googleapis.com/v4/${name}`,
          published_at: created?.createTime ?? at.toISOString(),
        });
        await run({ post_id: row.id, client_id: row.client_id, mode, outcome: "published", http_status: answer.status, detail: name });
      } else {
        await finishFailure(row, mode, row.publish_attempts, answer.status, googleMessage(answer));
      }
    }
    return report;
  }

  async function handle(req: Request): Promise<Response> {
    const body = await req.json().catch(() => ({}));
    const cron = await store.secret("SYNC_CRON_SECRET");
    const isCron = !!cron && req.headers.get("x-cron-secret") === cron;
    if (isCron && (body?.mode ?? "tick") === "tick") {
      return Response.json(await tick({ mode: "tick" }));
    }
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const member = await store.teamMemberForJwt(jwt);
    if (!member) return Response.json({ error: "forbidden" }, { status: isCron || jwt ? 403 : 401 });
    if (body?.mode !== "now" || typeof body?.post_id !== "string") {
      return Response.json({ error: "A team member may only ask to publish one post now: { mode: \"now\", post_id }" }, { status: 400 });
    }
    return Response.json(await tick({ mode: "now", postId: body.post_id }));
  }

  return { tick, handle };
}
