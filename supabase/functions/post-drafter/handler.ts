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
// v2, Authority mode (additive; migration 0053): brief / check / submit with
// authority_opportunity_id and no target. The target is derived from the
// opportunity the latest completed analysis reports; the caller cannot name
// or override it (a target alongside the id is refused). Every mode checks
// the opportunity first (current, Ready, eligible, not dismissed, nothing in
// review or approved this cycle, no Business Profile post for the service
// and intent in the last 21 days), then builds the Drafter's own brief
// exactly as v1 does, refuses any disagreement with the opportunity (target
// or evidence) and adds brief.authority. check and submit also lint for a
// duplicate of a recent post. submit needs a teammate's open Draft with AI
// request, and drafter_write repeats every check in its transaction and
// links the post. An Authority conflict is a 409 and records no Drafter run;
// the Drafter's own refusals are recorded as in v1, with the opportunity.
//
// There is no approve, schedule or publish mode, and nothing here reads copy
// from anywhere but the caller's draft, judged against the brief the server
// rebuilt itself. The model runtime is the caller's business: it sends a
// label (`runtime`), never a vendor-specific payload.
//
// Callers: the worker (x-cron-secret) or a signed-in team member (JWT on
// team_members). Nothing else.
import {
  briefConflicts,
  deriveTarget,
  duplicateProblems,
  opportunityConflicts,
  requestConflict,
  withAuthority,
  type AuthorityBrief,
  type AuthorityConflict,
  type AuthorityState,
} from "./authority.ts";
import { buildBrief, briefHash } from "./brief.ts";
import { lintDraft } from "./lint.ts";
import { MAX_ATTEMPTS, modelRequest } from "./prompt.ts";
import type { Store, WriteError } from "./store.ts";
import { DRAFTER_VERSION, type Brief, type DraftTarget, type LintResult, type ModelDraft } from "./types.ts";

export const HANDLER_VERSION = 2;
export const MODES = ["brief", "check", "submit", "version"] as const;
export const FEATURES = ["authority_mode", "duplicate_recent_post"] as const;

export type Deps = {
  store: Store;
  // Place names by state (the bundled GeoNames list), for the location rule.
  gazetteer?: Record<string, string[]>;
  // The clock (tests).
  now?: () => Date;
};

// Compass's calendar day (the Authority engine and 0053 judge cadence in Chicago).
export function chicagoDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

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

  const conflictReply = (opportunityId: string, conflicts: AuthorityConflict[]) =>
    reply(conflicts.some((c) => c.code === "opportunity_not_found") ? 404 : 409, {
      error: "authority_conflict", authority_opportunity_id: opportunityId, code: conflicts[0].code, conflicts,
      message: conflicts.map((c) => c.message).join(" "),
    });

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const who = await caller(req);
    if (!who) return reply(req.headers.get("Authorization") || req.headers.get("x-cron-secret") ? 403 : 401, { error: "forbidden" });
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return reply(400, { error: "JSON body required" });
    const mode = body.mode;

    if (mode === "version") {
      return reply(200, { version: HANDLER_VERSION, drafter: DRAFTER_VERSION, modes: MODES, features: FEATURES, max_attempts: MAX_ATTEMPTS });
    }
    if (mode !== "brief" && mode !== "check" && mode !== "submit") {
      return reply(400, { error: `mode is one of ${MODES.join(", ")}` });
    }
    const clientId = body.client_id;
    if (typeof clientId !== "string" || !UUID.test(clientId)) return reply(400, { error: "client_id must be a uuid" });

    // ── Authority mode: the target comes from the opportunity, never the caller ──
    const opportunityId = body.authority_opportunity_id;
    let authority: { id: string; state: AuthorityState; now: Date } | null = null;
    let target: DraftTarget;
    if (opportunityId != null) {
      if (typeof opportunityId !== "string" || !UUID.test(opportunityId)) return reply(400, { error: "authority_opportunity_id must be a uuid" });
      if (body.target != null) {
        return reply(400, { error: "target_not_allowed", message: "Authority mode derives the target from the opportunity; send authority_opportunity_id without a target." });
      }
      const expected = body.expected_run_id;
      if (expected != null && (typeof expected !== "string" || !UUID.test(expected))) return reply(400, { error: "expected_run_id must be a uuid" });
      const now = deps.now?.() ?? new Date();
      const state = await store.authority(clientId, opportunityId, now);
      const conflicts = opportunityConflicts(state, clientId, { expectedRunId: (expected as string | undefined) ?? null, today: chicagoDay(now), now });
      if (conflicts.length) return conflictReply(opportunityId, conflicts);
      authority = { id: opportunityId, state, now };
      target = deriveTarget(state.opportunity!);
    } else {
      const parsed = parseTarget(body.target);
      if (typeof parsed === "string") return reply(400, { error: parsed });
      target = parsed;
    }

    const built = await rebuild(clientId, target);
    if (!built.ok) return reply(built.status, authority ? { ...built.body, authority_opportunity_id: authority.id } : built.body);
    let brief: Brief | AuthorityBrief = built.brief;
    const state = built.state;
    if (authority) {
      const conflicts = briefConflicts(authority.state, built.brief);
      if (conflicts.length) return conflictReply(authority.id, conflicts);
      brief = withAuthority(built.brief, authority.state, authority.now);
    }
    const hash = authority ? await briefHash(brief) : built.hash;
    const request = authority?.state.request ? { task_id: authority.state.request.task_id, status: authority.state.request.status } : null;
    const extra = authority ? { authority_opportunity_id: authority.id, request } : {};

    if (mode === "brief") {
      return reply(200, { eligible: true, brief_hash: hash, brief, model_request: modelRequest(brief), max_attempts: MAX_ATTEMPTS, ...extra });
    }

    const draft = parseDraft(body.draft);
    if (typeof draft === "string") return reply(400, { error: draft });
    const stale = body.brief_hash !== hash;
    const lint = (): LintResult => {
      const r = lintDraft(brief, draft, { gazetteer: (state && deps.gazetteer?.[state]) || [] });
      if (!authority) return r;
      const a = (brief as AuthorityBrief).authority;
      const problems = [...r.problems, ...duplicateProblems(draft.copy, a.recent_posts, authority.state.recent_posts)];
      const warnings = [...r.warnings];
      if (a.preferred_claim_ids.length && !draft.claim_ids.some((id) => a.preferred_claim_ids.includes(id))) {
        warnings.push({ code: "authority_evidence_unused", message: "None of the analysis's preferred claims is linked." });
      }
      return { ok: problems.length === 0, problems, warnings };
    };

    if (mode === "check") {
      if (stale) return reply(409, { error: "stale_brief", brief_hash: hash, message: "The brief changed; rebuild it and draft again.", ...extra });
      const result = lint();
      return reply(200, {
        brief_hash: hash, characters: draft.copy.trim().length, ...result, ...extra,
        ...(result.ok ? {} : { revision_request: modelRequest(brief, { previous: draft, problems: result.problems }) }),
      });
    }

    // ── submit ──
    const runtime = typeof body.runtime === "string" ? body.runtime.trim() : "";
    if (runtime.length < 1 || runtime.length > 80) return reply(400, { error: "runtime (a 1–80 character label for the model runtime) is required" });
    if (authority) {
      const missing = requestConflict(authority.state);
      if (missing) return conflictReply(authority.id, [missing]);
    }
    const used = await store.attempts(clientId, hash);
    if (used >= MAX_ATTEMPTS) {
      return reply(429, { error: "attempts_exhausted", brief_hash: hash, message: `${MAX_ATTEMPTS} submits were made against this brief; stop and leave it for a person.` });
    }
    const attempt = used + 1;
    const provenance = authority ? { authority_opportunity_id: authority.id } : {};
    const record = (status: "lint_failed" | "refused", detail: string, lintResult: LintResult) =>
      store.recordRun({
        client_id: clientId, requested_via: who.via, requested_by: who.memberId, target: brief.target,
        brief_version: brief.version, brief_hash: hash, brief, claim_ids: draft.claim_ids, runtime, attempt,
        lint: lintResult, status, detail, ...provenance,
      });

    if (stale) {
      // Recorded under the hash the caller drafted against, when it is one.
      const claimed = typeof body.brief_hash === "string" && /^sha256:[0-9a-f]{64}$/.test(body.brief_hash) ? body.brief_hash : hash;
      await store.recordRun({
        client_id: clientId, requested_via: who.via, requested_by: who.memberId, target: brief.target,
        brief_version: brief.version, brief_hash: claimed, brief, claim_ids: draft.claim_ids, runtime, attempt,
        lint: null, status: "stale_brief", detail: `Drafted against ${claimed}; the live brief is ${hash}.`, ...provenance,
      });
      return reply(409, { error: "stale_brief", brief_hash: hash, message: "The brief changed; rebuild it and draft again." });
    }

    const result = lint();
    if (!result.ok) {
      await record("lint_failed", result.problems.map((p) => p.code).join(", "), result);
      return reply(422, { error: "lint_failed", brief_hash: hash, attempt, attempts_left: MAX_ATTEMPTS - attempt, ...result });
    }

    const written = await store.write({
      client_id: clientId, requested_via: who.via, requested_by: who.memberId, runtime, attempt,
      brief_version: brief.version, brief_hash: hash, brief, lint: result,
      copy: draft.copy, claim_ids: draft.claim_ids, asset_ids: draft.asset_ids ?? brief.target.assets.map((a) => a.id),
      ...(authority ? { authority_opportunity_id: authority.id, authority_run_id: (brief as AuthorityBrief).authority.run_id } : {}),
    });
    if ("error" in written) {
      const e: WriteError = written.error;
      // The opportunity changed between the checks above and the write
      // (drafter_write re-checks under a row lock): an Authority conflict,
      // not a Drafter refusal, so no run is recorded.
      if (authority && e.code === "AU409") {
        const m = /authority_conflict (\w+): (.*)/.exec(e.message);
        return conflictReply(authority.id, [{ code: m?.[1] ?? "conflict", message: m?.[2] ?? e.message }]);
      }
      await record("refused", `${e.code ?? ""} ${e.message}`.trim().slice(0, 500), result);
      return reply(e.code === "23505" ? 409 : 422, { error: "refused", code: e.code, message: e.message, brief_hash: hash, attempt });
    }
    return reply(201, {
      status: "in_review", brief_hash: hash, attempt, warnings: result.warnings,
      run_id: written.run_id, post_id: written.post_id, review_task_id: written.review_task_id,
      ...(authority ? { authority_opportunity_id: authority.id } : {}),
    });
  }

  return { handle };
}
