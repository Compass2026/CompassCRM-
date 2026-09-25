// post-drafter — AI Drafter v1, Deliverable 2: the governed write path.
//
//   brief   → rebuild the governed brief from LIVE Client Intelligence (the
//             canonical loader, 0047) and return it with its hash and the
//             model request. Writes nothing.
//   check   → rebuild the brief, refuse a stale hash, lint a draft. Writes
//             nothing; a model adapter revises against the SAME brief.
//   submit  → rebuild the brief, refuse a stale hash, lint, then ONE call to
//             drafter_write (one transaction: run, post, claims, assets,
//             draft → in_review; 0045 re-checks grounding and opens the
//             CLAUDE_APPROVAL review task). A refused submit is recorded as
//             a drafter_runs row (stale_brief / lint_failed / refused).
//   version → what this deployment is, for the worker's preflight.
//
// There is no approve, schedule or publish mode, and nothing here reads copy
// from anywhere but the caller's draft, judged against the brief the server
// rebuilt itself. The model runtime is the caller's business: it sends a
// label (`runtime`), never a vendor-specific payload.
//
// Callers: the worker (x-cron-secret) or a signed-in team member (JWT on
// team_members). Nothing else.
import { buildBrief, briefHash } from "./brief.ts";
import { lintDraft } from "./lint.ts";
import { MAX_ATTEMPTS, modelRequest } from "./prompt.ts";
import type { Store, WriteError } from "./store.ts";
import { DRAFTER_VERSION, type Brief, type DraftTarget, type LintResult, type ModelDraft } from "./types.ts";

export const HANDLER_VERSION = 1;
export const MODES = ["brief", "check", "submit", "version"] as const;

export type Deps = {
  store: Store;
  // Place names by state (the bundled GeoNames list), for the location rule.
  gazetteer?: Record<string, string[]>;
};

type Caller = { via: "worker" | "team"; memberId: string | null };
type Json = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status: number, body: Json) => Response.json(body, { status });

function parseTarget(t: unknown): DraftTarget | string {
  if (!t || typeof t !== "object") return "target is required";
  const o = t as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null);
  if (!str("channel") || !str("intent")) return "target.channel and target.intent are required";
  const postType = str("postType") ?? "standard";
  if (postType !== "standard" && postType !== "offer") return "target.postType is standard or offer";
  for (const k of ["serviceId", "keywordId", "offerId"]) {
    if (o[k] != null && !(typeof o[k] === "string" && UUID.test(o[k] as string))) return `target.${k} must be a uuid`;
  }
  const assetIds = o.assetIds ?? [];
  if (!Array.isArray(assetIds) || assetIds.some((a) => typeof a !== "string" || !UUID.test(a))) return "target.assetIds must be uuids";
  return {
    channel: str("channel")!,
    postType,
    intent: str("intent")!,
    serviceId: (o.serviceId as string | null) ?? null,
    keywordId: (o.keywordId as string | null) ?? null,
    ctaType: str("ctaType"),
    ctaUrl: str("ctaUrl"),
    offerId: (o.offerId as string | null) ?? null,
    assetIds: assetIds as string[],
  };
}

function parseDraft(d: unknown): ModelDraft | string {
  if (!d || typeof d !== "object") return "draft is required: { copy, claim_ids }";
  const o = d as Record<string, unknown>;
  if (typeof o.copy !== "string" || !o.copy.trim()) return "draft.copy is required";
  if (!Array.isArray(o.claim_ids) || o.claim_ids.some((c) => typeof c !== "string" || !UUID.test(c))) return "draft.claim_ids must be uuids";
  if (o.asset_ids != null && (!Array.isArray(o.asset_ids) || o.asset_ids.some((a) => typeof a !== "string" || !UUID.test(a)))) {
    return "draft.asset_ids must be uuids";
  }
  return { copy: o.copy, claim_ids: o.claim_ids as string[], ...(o.asset_ids ? { asset_ids: o.asset_ids as string[] } : {}) };
}

export function createPostDrafter(deps: Deps) {
  const { store } = deps;

  async function caller(req: Request): Promise<Caller | null> {
    const cron = await store.secret("SYNC_CRON_SECRET");
    if (cron && req.headers.get("x-cron-secret") === cron) return { via: "worker", memberId: null };
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const member = await store.teamMemberForJwt(jwt);
    return member ? { via: "team", memberId: member } : null;
  }

  // The brief is always rebuilt here, from live data; a caller never hands
  // one in.
  async function rebuild(clientId: string, target: DraftTarget):
    Promise<{ ok: true; brief: Brief; hash: string; state: string | null } | { ok: false; status: number; body: Json }> {
    const input = await store.input(clientId);
    if (!input?.client) return { ok: false, status: 404, body: { error: "client_not_found" } };
    const result = buildBrief(input, target);
    if (!result.ok) return { ok: false, status: 422, body: { eligible: false, refusals: result.refusals } };
    return { ok: true, brief: result.brief, hash: await briefHash(result.brief), state: input.client.state ?? null };
  }

  const lint = (brief: Brief, draft: ModelDraft, state: string | null): LintResult =>
    lintDraft(brief, draft, { gazetteer: (state && deps.gazetteer?.[state]) || [] });

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const who = await caller(req);
    if (!who) return reply(req.headers.get("Authorization") || req.headers.get("x-cron-secret") ? 403 : 401, { error: "forbidden" });
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return reply(400, { error: "JSON body required" });
    const mode = body.mode;

    if (mode === "version") {
      return reply(200, { version: HANDLER_VERSION, drafter: DRAFTER_VERSION, modes: MODES, max_attempts: MAX_ATTEMPTS });
    }
    if (mode !== "brief" && mode !== "check" && mode !== "submit") {
      return reply(400, { error: `mode is one of ${MODES.join(", ")}` });
    }
    const clientId = body.client_id;
    if (typeof clientId !== "string" || !UUID.test(clientId)) return reply(400, { error: "client_id must be a uuid" });
    const target = parseTarget(body.target);
    if (typeof target === "string") return reply(400, { error: target });

    const built = await rebuild(clientId, target);
    if (!built.ok) return reply(built.status, built.body);
    const { brief, hash, state } = built;

    if (mode === "brief") {
      return reply(200, { eligible: true, brief_hash: hash, brief, model_request: modelRequest(brief), max_attempts: MAX_ATTEMPTS });
    }

    const draft = parseDraft(body.draft);
    if (typeof draft === "string") return reply(400, { error: draft });
    const stale = body.brief_hash !== hash;

    if (mode === "check") {
      if (stale) return reply(409, { error: "stale_brief", brief_hash: hash, message: "The brief changed; rebuild it and draft again." });
      const result = lint(brief, draft, state);
      return reply(200, {
        brief_hash: hash, characters: draft.copy.trim().length, ...result,
        ...(result.ok ? {} : { revision_request: modelRequest(brief, { previous: draft, problems: result.problems }) }),
      });
    }

    // ── submit ──
    const runtime = typeof body.runtime === "string" ? body.runtime.trim() : "";
    if (runtime.length < 1 || runtime.length > 80) return reply(400, { error: "runtime (a 1–80 character label for the model runtime) is required" });
    const used = await store.attempts(clientId, hash);
    if (used >= MAX_ATTEMPTS) {
      return reply(429, { error: "attempts_exhausted", brief_hash: hash, message: `${MAX_ATTEMPTS} submits were made against this brief; stop and leave it for a person.` });
    }
    const attempt = used + 1;
    const record = (status: "lint_failed" | "refused", detail: string, lintResult: LintResult) =>
      store.recordRun({
        client_id: clientId, requested_via: who.via, requested_by: who.memberId, target: brief.target,
        brief_version: brief.version, brief_hash: hash, brief, claim_ids: draft.claim_ids, runtime, attempt,
        lint: lintResult, status, detail,
      });

    if (stale) {
      // Recorded under the hash the caller drafted against, when it is one.
      const claimed = typeof body.brief_hash === "string" && /^sha256:[0-9a-f]{64}$/.test(body.brief_hash) ? body.brief_hash : hash;
      await store.recordRun({
        client_id: clientId, requested_via: who.via, requested_by: who.memberId, target: brief.target,
        brief_version: brief.version, brief_hash: claimed, brief, claim_ids: draft.claim_ids, runtime, attempt,
        lint: null, status: "stale_brief", detail: `Drafted against ${claimed}; the live brief is ${hash}.`,
      });
      return reply(409, { error: "stale_brief", brief_hash: hash, message: "The brief changed; rebuild it and draft again." });
    }

    const result = lint(brief, draft, state);
    if (!result.ok) {
      await record("lint_failed", result.problems.map((p) => p.code).join(", "), result);
      return reply(422, { error: "lint_failed", brief_hash: hash, attempt, attempts_left: MAX_ATTEMPTS - attempt, ...result });
    }

    const written = await store.write({
      client_id: clientId, requested_via: who.via, requested_by: who.memberId, runtime, attempt,
      brief_version: brief.version, brief_hash: hash, brief, lint: result,
      copy: draft.copy, claim_ids: draft.claim_ids, asset_ids: draft.asset_ids ?? brief.target.assets.map((a) => a.id),
    });
    if ("error" in written) {
      const e: WriteError = written.error;
      await record("refused", `${e.code ?? ""} ${e.message}`.trim().slice(0, 500), result);
      return reply(e.code === "23505" ? 409 : 422, { error: "refused", code: e.code, message: e.message, brief_hash: hash, attempt });
    }
    return reply(201, {
      status: "in_review", brief_hash: hash, attempt, warnings: result.warnings,
      run_id: written.run_id, post_id: written.post_id, review_task_id: written.review_task_id,
    });
  }

  return { handle };
}
