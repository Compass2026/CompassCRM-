// content-drafter — Blog Drafter v1's governed write path (0067).
//
//   brief   → rebuild the blog brief from LIVE data for a requested draft
//             and return it with its hash. Writes nothing.
//   check   → rebuild the brief, refuse a stale hash, lint a draft. Writes
//             nothing; the model adapter revises against the SAME brief.
//   submit  → rebuild the brief, refuse a stale hash, lint, then ONE call to
//             content_draft_write (claims, content, lint, in_review; the
//             request task closes). A draft that does not pass is not
//             written anywhere.
//   open    → the weekly blog (0068): the worker opens the draft for a
//             blog_post task (content_draft_open_weekly; the same draft on a
//             repeat). The task closes only when the draft is approved.
//   version → what this deployment is, for the worker's preflight.
//
// Nothing here approves, finalizes or publishes: approval is a teammate's
// (content_draft_approve), and that is the only way a blog becomes a
// content_posts row. The model runtime is the caller's business: it sends a
// label (`runtime`), never a vendor-specific payload.
//
// Callers: the worker (x-cron-secret) or a signed-in team member (JWT on
// team_members). Nothing else.
import { blogBriefHash, buildBlogBrief, CONTENT_DRAFTER_VERSION, type BlogBrief } from "./brief.ts";
import { lintBlog, type BlogDraft } from "./lint.ts";
import type { Store } from "./store.ts";

export const HANDLER_VERSION = 2;
export const MODES = ["brief", "check", "submit", "open", "version"] as const;

export type Deps = { store: Store; gazetteer?: Record<string, string[]> };
type Json = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status: number, body: Json) => Response.json(body, { status });
const isStr = (v: unknown): v is string => typeof v === "string";

export function parseBlogDraft(d: unknown): BlogDraft | string {
  if (!d || typeof d !== "object") return "draft is required";
  const o = d as Record<string, unknown>;
  for (const k of ["title", "slug", "meta_title", "meta_description", "h1", "body_markdown"]) {
    if (!isStr(o[k])) return `draft.${k} must be a string`;
  }
  if (!Array.isArray(o.outline) || o.outline.some((x) => !x || typeof x !== "object" || !isStr((x as Json).heading) || typeof (x as Json).level !== "number")) {
    return "draft.outline is a list of { level, heading }";
  }
  if (!Array.isArray(o.internal_links) || o.internal_links.some((x) => !x || typeof x !== "object" || !isStr((x as Json).url) || !isStr((x as Json).anchor))) {
    return "draft.internal_links is a list of { url, anchor, reason? }";
  }
  const cta = o.cta as Json | undefined;
  if (!cta || typeof cta !== "object" || !isStr(cta.text) || !(cta.url == null || isStr(cta.url))) return "draft.cta is { text, url }";
  if (!Array.isArray(o.claim_ids) || o.claim_ids.some((c) => !isStr(c) || !UUID.test(c))) return "draft.claim_ids must be uuids";
  return {
    title: o.title as string, slug: o.slug as string, meta_title: o.meta_title as string, meta_description: o.meta_description as string,
    h1: o.h1 as string, body_markdown: o.body_markdown as string,
    outline: (o.outline as Json[]).map((x) => ({ level: x.level as number, heading: x.heading as string })),
    internal_links: (o.internal_links as Json[]).map((x) => ({ url: x.url as string, anchor: x.anchor as string, ...(isStr(x.reason) ? { reason: x.reason } : {}) })),
    cta: { text: cta.text as string, url: (cta.url as string | null) ?? null },
    claim_ids: o.claim_ids as string[],
  };
}

export function createContentDrafter(deps: Deps) {
  const { store } = deps;

  async function caller(req: Request): Promise<{ via: "worker" | "team"; memberId: string | null } | null> {
    const cron = await store.secret("SYNC_CRON_SECRET");
    if (cron && req.headers.get("x-cron-secret") === cron) return { via: "worker", memberId: null };
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const member = await store.teamMemberForJwt(jwt);
    return member ? { via: "team", memberId: member } : null;
  }

  async function rebuild(draftId: string):
    Promise<{ ok: true; brief: BlogBrief; hash: string; state: string | null } | { ok: false; status: number; body: Json }> {
    const draft = await store.draft(draftId);
    if (!draft) return { ok: false, status: 404, body: { error: "draft_not_found" } };
    if (!["requested", "draft", "rejected"].includes(draft.status)) {
      return { ok: false, status: 409, body: { error: "draft_not_open", message: `The draft is ${draft.status}; nothing to write.` } };
    }
    const input = await store.input(draft.client_id);
    if (!input?.client) return { ok: false, status: 404, body: { error: "client_not_found" } };
    const result = buildBlogBrief(input, draft, await store.sitePages(draft.client_id));
    if (!result.ok) return { ok: false, status: 422, body: { eligible: false, refusals: result.refusals } };
    return { ok: true, brief: result.brief, hash: await blogBriefHash(result.brief), state: input.client.state ?? null };
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const who = await caller(req);
    if (!who) return reply(req.headers.get("Authorization") || req.headers.get("x-cron-secret") ? 403 : 401, { error: "forbidden" });
    const body = (await req.json().catch(() => null)) as Json | null;
    if (!body || typeof body !== "object") return reply(400, { error: "JSON body required" });
    const mode = body.mode;
    if (mode === "version") return reply(200, { version: HANDLER_VERSION, drafter: CONTENT_DRAFTER_VERSION, modes: MODES, kinds: ["blog"], features: ["weekly_open"] });
    if (mode === "open") {
      if (who.via !== "worker") return reply(403, { error: "open is the worker's (the weekly blog task)" });
      const taskId = body.task_id;
      if (!isStr(taskId) || !UUID.test(taskId)) return reply(400, { error: "task_id must be a uuid" });
      if (!isStr(body.topic) || !body.topic.trim()) return reply(400, { error: "topic is required" });
      if (!isStr(body.search_intent)) return reply(400, { error: "search_intent is required" });
      for (const k of ["keyword_id", "service_id"]) {
        if (body[k] != null && (!isStr(body[k]) || !UUID.test(body[k] as string))) return reply(400, { error: `${k} must be a uuid` });
      }
      const opened = await store.openWeekly({
        task_id: taskId, topic: body.topic.trim(), search_intent: body.search_intent,
        keyword_id: body.keyword_id ?? null, service_id: body.service_id ?? null,
      });
      if ("error" in opened) {
        const status = opened.error.code === "P0002" ? 404 : opened.error.code === "22023" ? 409 : opened.error.code === "42501" ? 403 : 500;
        return reply(status, { error: "open_refused", message: opened.error.message });
      }
      return reply(opened.reused ? 200 : 201, opened);
    }
    if (mode !== "brief" && mode !== "check" && mode !== "submit") return reply(400, { error: `mode is one of ${MODES.join(", ")}` });
    const draftId = body.draft_id;
    if (!isStr(draftId) || !UUID.test(draftId)) return reply(400, { error: "draft_id must be a uuid" });

    const built = await rebuild(draftId);
    if (!built.ok) return reply(built.status, built.body);
    if (mode === "brief") return reply(200, { eligible: true, brief: built.brief, brief_hash: built.hash });

    if (body.brief_hash !== built.hash && (mode === "submit" || body.brief_hash != null)) {
      return reply(409, { error: "stale_brief", message: "The client's record changed since the brief was built; fetch the brief again.", brief_hash: built.hash });
    }
    const draft = parseBlogDraft(body.draft);
    if (typeof draft === "string") return reply(400, { error: draft });
    const lint = lintBlog(built.brief, draft, { gazetteer: (built.state && deps.gazetteer?.[built.state]) || [] });
    if (mode === "check") return reply(200, { ...lint, brief_hash: built.hash });

    const runtime = body.runtime;
    if (!isStr(runtime) || !runtime.trim() || runtime.length > 80) return reply(400, { error: "runtime is a short label for the model runtime" });
    if (!lint.ok) return reply(422, { error: "lint_failed", ...lint });
    const { claim_ids, ...content } = draft;
    const written = await store.write({
      draft_id: draftId, brief: built.brief, brief_hash: built.hash, runtime: runtime.trim(), lint, claim_ids, content, submit: true,
    });
    if ("error" in written) {
      const status = written.error.code === "42501" ? 403 : written.error.code === "23514" || written.error.code === "P0002" ? 409 : 500;
      return reply(status, { error: "write_refused", message: written.error.message });
    }
    return reply(201, { ...written, warnings: lint.warnings });
  }

  return { handle };
}
