// content-approvals — delegated approval and publication of blog drafts
// (20261019190532) and Facebook / Business Profile posts (20261019202359). Executive OS is the only caller: it holds the owner's
// standing grant (or a per-request approval) and relays Tom's explicit
// instruction from ChatGPT or Claude. See docs/delegated-content-approval.md.
//
//   version   → what this deployment is.
//   batch     → a client's blog drafts and Facebook / Business Profile posts in
//               review or approved (optionally one channel), each with its
//               review hash (the complete publishable content + destination:
//               website, Page or location), whether the existing publisher
//               would send it, and its publication state. Writes nothing.
//   authorize → record the receipt (idempotent per operation_id), then execute
//               it in ONE transaction: re-check every item, then the existing
//               content_draft_approve / blog_publication_queue for blogs, the
//               social review gate and the existing schedule (post-publisher
//               sends it) for posts. A check that fails refuses the receipt
//               with its reason; nothing changes.
//   status    → the receipt and each item's state now: approved · scheduled ·
//               queued · publishing · published (URL, provider post id) ·
//               failed (reason) · uncertain.
//
// Delegated post edits (20261020200000, docs/delegated-post-edits.md): Claude
// or ChatGPT revises ONE Facebook / Business Profile post in review, never
// approving, scheduling or publishing it.
//   stage_media   → record a declared file for one post and hand out a signed,
//                   single-use upload URL for its content-addressed path
//                   (never overwritten). Writes no post.
//   revise        → record the receipt (idempotent per operation_id), measure
//                   the stored bytes here (sha256, signature type, size,
//                   dimensions), then in ONE transaction withdraw the post,
//                   replace its media and resubmit it for a fresh review.
//                   change.kind replace_copy (20261029180000) instead lints
//                   the proposed copy and claims against a brief rebuilt for
//                   the post's own target (the post-drafter's rules), then in
//                   ONE transaction withdraws the post, sets its copy, links
//                   exactly those claims and resubmits it.
//   revise_status → the receipt and the post now.
//
// Auth: the x-compass-delegation-key header must equal the Vault secret
// EXECUTIVE_OS_DELEGATION_SECRET (constant-time). Nothing else is accepted —
// not a team JWT, not the cron secret. Executive OS never touches the database.
//
// Outcome honesty: a PostgREST error with a SQLSTATE proves the function ran
// and rolled back (refused). Anything else (network, timeout) is UNKNOWN: the
// caller retries with the SAME operation_id, which returns the receipt and
// never executes twice.

import { measure, sha256Hex } from "../_shared/image-meta.ts";
import type { CopyCheckResult } from "./copy-check.ts";

export const HANDLER_VERSION = 4;
export const MODES = ["version", "batch", "authorize", "status", "stage_media", "revise", "revise_status"] as const;
const ACTIONS = ["approve", "publish", "approve_and_publish"] as const;
const CHANNELS = ["chatgpt", "claude"] as const;
export const CONTENT_CHANNELS = ["blog", "facebook", "google_business"] as const;
const MAX_ITEMS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
const POST_CHANNELS = ["facebook", "google_business"] as const;
const EDIT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_EDIT_BYTES = 30 * 1024 * 1024;
export const EDIT_KINDS = ["replace_media", "replace_copy"] as const;
export const MAX_COPY_CHARS = 5000;
const MAX_COPY_CLAIMS = 10;

type Json = Record<string, unknown>;
export type DbError = { code: string | null; message: string };
export type DbResult<T> = { data: T | null; error: DbError | null };

export type StoredRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "missing" | "unreadable" | "too_large"; detail?: string };

export type Store = {
  secret(name: string): Promise<string | null>;
  clientsNamed(name: string): Promise<{ id: string; name: string }[]>;
  batch(clientId: string, channel: string | null): Promise<DbResult<Json>>;
  record(p: Json): Promise<DbResult<Json>>;
  execute(id: string): Promise<DbResult<Json>>;
  refuse(id: string, code: string, message: string): Promise<DbResult<Json>>;
  status(operationId: string): Promise<DbResult<Json>>;
  // Delegated post edits.
  editStage(p: Json): Promise<DbResult<Json>>;
  uploadSlot(storagePath: string): Promise<{ exists: true } | { exists: false; signed_url: string; token: string }>;
  read(storagePath: string): Promise<StoredRead>;
  editRecord(p: Json): Promise<DbResult<Json>>;
  editExecute(id: string, measured: Json): Promise<DbResult<Json>>;
  editRefuse(id: string, code: string, message: string): Promise<DbResult<Json>>;
  editStatus(operationId: string): Promise<DbResult<Json>>;
};

const reply = (status: number, body: Json) => Response.json(body, { status });
// A thrown call (network, timeout) proves nothing about the database.
const unconfirmed = (e: unknown): DbResult<Json> => ({ data: null, error: { code: null, message: e instanceof Error ? e.message : String(e) } });
const isStr = (v: unknown): v is string => typeof v === "string";

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// "stale_version: …" → stale_version; anything else → refused.
function refusalCode(message: string): string {
  const m = /^([a-z_]{3,40}):/.exec(message);
  return m ? m[1] : "refused";
}

// SQLSTATEs the receipt functions raise for a refusal (as opposed to an
// unexpected failure): checks, authorization, invalid input, conflicts.
const REFUSAL = /^(23|42|22|P0|CD)/;

/** Validates an authorize request. Returns the RPC payload or an error message. */
export function parseAuthorize(b: Json): Json | string {
  const instruction = (b.instruction ?? {}) as Json;
  if (!isStr(b.operation_id) || !OPERATION.test(b.operation_id)) return "operation_id is 8–128 letters, digits, _ or -";
  if (!isStr(b.client_id) || !UUID.test(b.client_id)) return "client_id must be a uuid";
  if (!ACTIONS.includes(b.action as typeof ACTIONS[number])) return `action is one of ${ACTIONS.join(", ")}`;
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > MAX_ITEMS) return `items lists 1–${MAX_ITEMS} items`;
  const seen = new Set<string>();
  const items: Json[] = [];
  for (const it of b.items as Json[]) {
    if (!it || typeof it !== "object") return "each item is an object";
    // v1 (blogs): {draft_id, version, review_hash} with a request destination_url.
    const channel = it.channel ?? "blog";
    if (!CONTENT_CHANNELS.includes(channel as typeof CONTENT_CHANNELS[number])) return `item channel is one of ${CONTENT_CHANNELS.join(", ")}`;
    const id = it.id ?? it.draft_id ?? it.post_id;
    if (!isStr(id) || !UUID.test(id)) return "each item needs its id from batch";
    if (channel === "blog" && (!Number.isInteger(it.version) || (it.version as number) < 1)) return "each blog item needs its reviewed version";
    if (!isStr(it.review_hash) || !HASH.test(it.review_hash)) return "each item needs the review_hash from batch";
    const destination = it.destination ?? (channel === "blog" ? b.destination_url : undefined);
    if (!isStr(destination) || !destination.trim() || destination.length > 300) return "each item needs its destination from batch";
    if (channel === "blog" && !/^https:\/\/[^\s/]+\/?$/.test(destination)) return "a blog item's destination is the website origin from batch";
    if (seen.has(id)) return "an item appears twice";
    seen.add(id);
    items.push({ channel, id, ...(channel === "blog" ? { version: it.version } : {}), review_hash: it.review_hash,
      destination: channel === "blog" ? destination.replace(/\/$/, "") : destination });
  }
  if (b.destination_url != null && (!isStr(b.destination_url) || !/^https:\/\/[^\s/]+\/?$/.test(b.destination_url))) return "destination_url is the website origin from batch";
  if (b.publish_at != null && (!isStr(b.publish_at) || !Number.isFinite(Date.parse(b.publish_at)))) return "publish_at is an ISO time";
  if (b.action === "approve" && b.publish_at != null) return "approve never publishes; publish_at is only for publish actions";
  if (!isStr(instruction.text) || !instruction.text.trim() || instruction.text.length > 2000) return "instruction.text is the owner's exact words";
  if (!CHANNELS.includes(instruction.channel as typeof CHANNELS[number])) return "instruction.channel is chatgpt or claude";
  if (!isStr(instruction.account_email) || !/^[^@\s]+@[^@\s]+$/.test(instruction.account_email)) return "instruction.account_email is the authenticated owner";
  if (!isStr(instruction.executed_by) || !instruction.executed_by.trim()) return "instruction.executed_by names the assistant";
  if (instruction.at != null && (!isStr(instruction.at) || !Number.isFinite(Date.parse(instruction.at)))) return "instruction.at is an ISO time";
  if (b.source_ref != null && (typeof b.source_ref !== "object" || Array.isArray(b.source_ref))) return "source_ref is an object";
  return {
    operation_id: b.operation_id, client_id: b.client_id, action: b.action,
    items,
    ...(isStr(b.destination_url) ? { destination_url: b.destination_url.replace(/\/$/, "") } : {}),
    ...(b.publish_at ? { publish_at: b.publish_at } : {}),
    instruction_text: (instruction.text as string).trim(), instructed_at: instruction.at ?? null,
    channel: instruction.channel, account_email: instruction.account_email, executed_by: instruction.executed_by,
    ...(b.source_ref ? { source_ref: b.source_ref } : {}),
  };
}

const str = (v: unknown, max: number) => isStr(v) && v.trim().length > 0 && v.length <= max;

/** Validates a stage_media request. Returns the RPC payload or an error message. */
export function parseStage(b: Json): Json | string {
  const post = (b.post ?? {}) as Json;
  const f = (b.file ?? {}) as Json;
  if (!isStr(b.operation_id) || !OPERATION.test(b.operation_id)) return "operation_id is 8–128 letters, digits, _ or -";
  if (!isStr(b.client_id) || !UUID.test(b.client_id)) return "client_id must be a uuid";
  if (!POST_CHANNELS.includes(post.channel as typeof POST_CHANNELS[number])) return "post.channel is facebook or google_business";
  if (!isStr(post.id) || !UUID.test(post.id)) return "post.id must be a uuid";
  if (!isStr(f.sha256) || !HEX.test(f.sha256)) return "file.sha256 is a sha256 hex digest";
  if (!EDIT_TYPES.includes(f.mime_type as typeof EDIT_TYPES[number])) return `file.mime_type is one of ${EDIT_TYPES.join(", ")}`;
  if (!Number.isInteger(f.size_bytes) || (f.size_bytes as number) < 1 || (f.size_bytes as number) > MAX_EDIT_BYTES) return `file.size_bytes is 1–${MAX_EDIT_BYTES}`;
  for (const k of ["width", "height"]) {
    if (!Number.isInteger(f[k]) || (f[k] as number) < 1 || (f[k] as number) > 10000) return `file.${k} is 1–10000 pixels`;
  }
  if (!isStr(f.file_name) || !/^[\w.\- ]{1,200}$/.test(f.file_name)) return "file.file_name is a plain file name";
  return {
    operation_id: b.operation_id, client_id: b.client_id, post: { channel: post.channel, id: post.id },
    file: { sha256: f.sha256, size_bytes: f.size_bytes, mime_type: f.mime_type, width: f.width, height: f.height, file_name: f.file_name },
  };
}

/** Validates a revise request. Returns the RPC payload or an error message. */
export function parseRevise(b: Json): Json | string {
  const post = (b.post ?? {}) as Json;
  const change = (b.change ?? {}) as Json;
  const ex = (b.executor ?? {}) as Json;
  const au = (b.authority ?? {}) as Json;
  if (!isStr(b.operation_id) || !OPERATION.test(b.operation_id)) return "operation_id is 8–128 letters, digits, _ or -";
  if (!isStr(b.client_id) || !UUID.test(b.client_id)) return "client_id must be a uuid";
  if (!POST_CHANNELS.includes(post.channel as typeof POST_CHANNELS[number])) return "post.channel is facebook or google_business";
  if (!isStr(post.id) || !UUID.test(post.id)) return "post.id must be a uuid";
  if (!isStr(post.service_id) || !UUID.test(post.service_id)) return "post.service_id is the post's service from batch";
  if (!isStr(post.review_hash) || !HASH.test(post.review_hash)) return "post.review_hash is the review_hash from batch";
  if (!str(post.destination, 300)) return "post.destination is the destination from batch";
  if (!EDIT_KINDS.includes(change.kind as typeof EDIT_KINDS[number])) return `change.kind is one of ${EDIT_KINDS.join(", ")}`;
  if (change.kind === "replace_media") {
    if (!isStr(change.stage_id) || !UUID.test(change.stage_id)) return "change.stage_id is the stage from stage_media";
    if (!isStr(change.sha256) || !HEX.test(change.sha256)) return "change.sha256 is the staged file's sha256";
    if (!str(change.label, 200)) return "change.label names the asset";
    if (!str(change.provenance, 1000)) return "change.provenance says how the image was made";
  } else {
    if (!str(change.copy, MAX_COPY_CHARS)) return `change.copy is the post's new copy (1–${MAX_COPY_CHARS} characters)`;
    if (!Array.isArray(change.claim_ids) || change.claim_ids.length > MAX_COPY_CLAIMS
        || !change.claim_ids.every((c) => isStr(c) && UUID.test(c))) return `change.claim_ids lists up to ${MAX_COPY_CLAIMS} claim ids`;
    if (new Set(change.claim_ids as string[]).size !== change.claim_ids.length) return "change.claim_ids lists a claim twice";
  }
  if (!CHANNELS.includes(ex.channel as typeof CHANNELS[number])) return "executor.channel is chatgpt or claude";
  if (!str(ex.executed_by, 120)) return "executor.executed_by names the assistant";
  if (!isStr(ex.account_email) || !/^[^@\s]+@[^@\s]+$/.test(ex.account_email)) return "executor.account_email is the authorizing owner";
  if (au.kind !== "standing_policy" && au.kind !== "owner_approval") return "authority.kind is standing_policy or owner_approval";
  if (!str(au.id, 200)) return "authority.id is the policy or approval id";
  for (const k of ["channels", "service_ids", "operations"]) {
    if (!Array.isArray(au[k]) || !(au[k] as unknown[]).length || !(au[k] as unknown[]).every((v) => isStr(v))) return `authority.${k} lists what it covers`;
  }
  if (!str(b.reason, 1000)) return "reason says why, in the assistant's words";
  if (b.source_ref != null && (typeof b.source_ref !== "object" || Array.isArray(b.source_ref))) return "source_ref is an object";
  return {
    operation_id: b.operation_id, client_id: b.client_id,
    post: { channel: post.channel, id: post.id, service_id: (post.service_id as string).toLowerCase(), review_hash: post.review_hash,
            destination: (post.destination as string).trim() },
    change: change.kind === "replace_media"
      ? { kind: "replace_media", stage_id: change.stage_id, sha256: change.sha256, label: (change.label as string).trim(),
          provenance: (change.provenance as string).trim() }
      // The copy exactly as sent (it is what gets linted and published).
      : { kind: "replace_copy", copy: change.copy, claim_ids: (change.claim_ids as string[]).map((c) => c.toLowerCase()) },
    executor: { channel: ex.channel, executed_by: (ex.executed_by as string).trim(), account_email: ex.account_email },
    authority: { kind: au.kind, id: au.id, channels: au.channels, service_ids: au.service_ids, operations: au.operations },
    reason: (b.reason as string).trim(),
    ...(b.source_ref ? { source_ref: b.source_ref } : {}),
  };
}

export type ContentApprovalsDeps = {
  store: Store;
  // The post-drafter's brief and linter for a proposed copy edit (copy-check.ts).
  copyCheck?: (clientId: string, postId: string, copy: string, claimIds: string[]) => Promise<CopyCheckResult>;
};

export function createContentApprovals(deps: ContentApprovalsDeps) {
  const { store } = deps;

  async function authorized(req: Request): Promise<boolean> {
    const key = req.headers.get("x-compass-delegation-key");
    if (!key) return false;
    const secret = await store.secret("EXECUTIVE_OS_DELEGATION_SECRET");
    return !!secret && sameSecret(key, secret);
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    if (!(await authorized(req))) return reply(403, { error: "forbidden" });
    const body = (await req.json().catch(() => null)) as Json | null;
    if (!body || typeof body !== "object") return reply(400, { error: "JSON body required" });
    const mode = body.mode;

    if (mode === "version") {
      return reply(200, { version: HANDLER_VERSION, modes: MODES, actions: ACTIONS, channels: CHANNELS, content_channels: CONTENT_CHANNELS,
        edit_kinds: deps.copyCheck ? EDIT_KINDS : ["replace_media"] });
    }

    if (mode === "batch") {
      const channel = body.channel ?? null;
      if (channel !== null && !CONTENT_CHANNELS.includes(channel as typeof CONTENT_CHANNELS[number])) {
        return reply(400, { error: `channel is one of ${CONTENT_CHANNELS.join(", ")}` });
      }
      let clientId = isStr(body.client_id) && UUID.test(body.client_id) ? body.client_id : null;
      if (!clientId) {
        const name = isStr(body.client_name) ? body.client_name.trim() : "";
        if (name.length < 2) return reply(400, { error: "client_id or client_name is required" });
        const found = await store.clientsNamed(name);
        if (found.length === 0) return reply(404, { error: "client_not_found", message: `No client matches "${name}".` });
        if (found.length > 1) return reply(409, { error: "client_ambiguous", candidates: found });
        clientId = found[0].id;
      }
      const r = await store.batch(clientId, channel as string | null);
      if (r.error) return reply(r.error.code === "P0002" ? 404 : 500, { error: "batch_failed", message: r.error.message });
      return reply(200, r.data ?? {});
    }

    if (mode === "status") {
      if (!isStr(body.operation_id) || !OPERATION.test(body.operation_id)) return reply(400, { error: "operation_id is required" });
      const r = await store.status(body.operation_id);
      if (r.error) return reply(500, { error: "status_failed", message: r.error.message });
      if (!r.data) return reply(404, { error: "not_found", message: "No authorization with that operation_id: nothing was recorded." });
      return reply(200, { receipt: r.data });
    }

    if (mode === "authorize") {
      const p = parseAuthorize(body);
      if (typeof p === "string") return reply(400, { error: "invalid_request", message: p });
      const rec = await store.record(p).catch(unconfirmed);
      if (rec.error) {
        if (rec.error.code && REFUSAL.test(rec.error.code)) {
          const status = rec.error.code === "CD409" ? 409 : rec.error.code === "42501" ? 403 : 422;
          return reply(status, { error: refusalCode(rec.error.message), message: rec.error.message, recorded: false });
        }
        return reply(503, { error: "outcome_unknown", message: "Recording did not confirm; retry with the same operation_id." });
      }
      const receipt = rec.data as Json;
      if (receipt.status === "executed" || receipt.status === "refused") {
        return reply(200, { receipt, replayed: true });
      }
      const ex = await store.execute(receipt.id as string).catch(unconfirmed);
      if (ex.error) {
        if (ex.error.code && REFUSAL.test(ex.error.code)) {
          // The transaction rolled back: nothing was approved or queued.
          const code = refusalCode(ex.error.message);
          const refused = await store.refuse(receipt.id as string, code, ex.error.message);
          return reply(422, { error: code, message: ex.error.message, receipt: refused.data ?? receipt });
        }
        return reply(503, { error: "outcome_unknown", message: "Execution did not confirm; check status or retry with the same operation_id.", receipt });
      }
      return reply(201, { receipt: ex.data, replayed: false });
    }

    if (mode === "stage_media") return stageMedia(body);
    if (mode === "revise") return revise(body);
    if (mode === "revise_status") {
      if (!isStr(body.operation_id) || !OPERATION.test(body.operation_id)) return reply(400, { error: "operation_id is required" });
      const r = await store.editStatus(body.operation_id);
      if (r.error) return reply(500, { error: "status_failed", message: r.error.message });
      if (!r.data) return reply(404, { error: "not_found", message: "No edit with that operation_id: nothing was changed." });
      return reply(200, { receipt: r.data });
    }

    return reply(400, { error: `mode is one of ${MODES.join(", ")}` });
  }

  // A refusal SQLSTATE proves the database ran and refused; anything else is unknown.
  function refusedAtDb(e: DbError): Response {
    const status = e.code === "CD409" ? 409 : e.code === "42501" ? 403 : 422;
    return reply(status, { error: refusalCode(e.message), message: e.message, recorded: false });
  }

  async function stageMedia(body: Json): Promise<Response> {
    const p = parseStage(body);
    if (typeof p === "string") return reply(400, { error: "invalid_request", message: p });
    const st = await store.editStage(p).catch(unconfirmed);
    if (st.error) {
      if (st.error.code && REFUSAL.test(st.error.code)) return refusedAtDb(st.error);
      return reply(503, { error: "outcome_unknown", message: "Staging did not confirm; retry with the same operation_id." });
    }
    const stage = st.data as Json;
    let slot: Awaited<ReturnType<Store["uploadSlot"]>>;
    try {
      slot = await store.uploadSlot(String(stage.storage_path));
    } catch {
      return reply(503, { error: "outcome_unknown", message: "The upload slot did not confirm; retry with the same operation_id." });
    }
    return reply(stage.replayed ? 200 : 201, {
      stage: {
        id: stage.id, storage_path: stage.storage_path, expires_at: stage.expires_at, replayed: !!stage.replayed,
        already_stored: slot.exists, upload_url: slot.exists ? null : slot.signed_url, upload_token: slot.exists ? null : slot.token,
      },
    });
  }

  async function revise(body: Json): Promise<Response> {
    const p = parseRevise(body);
    if (typeof p === "string") return reply(400, { error: "invalid_request", message: p });
    const rec = await store.editRecord(p).catch(unconfirmed);
    if (rec.error) {
      if (rec.error.code && REFUSAL.test(rec.error.code)) return refusedAtDb(rec.error);
      return reply(503, { error: "outcome_unknown", message: "Recording did not confirm; retry with the same operation_id." });
    }
    const receipt = rec.data as Json;
    if (receipt.status === "executed" || receipt.status === "refused") return reply(200, { receipt, replayed: true });
    const id = receipt.id as string;
    const refuse = async (code: string, message: string, extra: Json = {}) => {
      const refused = await store.editRefuse(id, code, `${code}: ${message}`);
      return reply(422, { error: code, message: `${code}: ${message}`, ...extra, receipt: refused.data ?? receipt });
    };
    if ((p.change as Json).kind === "replace_copy") return reviseCopy(p, id, receipt, refuse);

    // The bytes as stored, measured here: the database never trusts a declared hash.
    let read: StoredRead;
    try {
      read = await store.read(String(receipt.storage_path));
    } catch {
      return reply(503, { error: "outcome_unknown", message: "The stored file could not be read; retry with the same operation_id.", receipt });
    }
    if (!read.ok) {
      if (read.reason === "missing") return refuse("bytes_missing", "nothing was uploaded to the slot");
      if (read.reason === "too_large") return refuse("bytes_mismatch", `the stored file is larger than ${MAX_EDIT_BYTES} bytes`);
      return reply(503, { error: "outcome_unknown", message: "The stored file could not be read; retry with the same operation_id.", receipt });
    }
    const meta = measure(read.bytes);
    if (!meta) return refuse("bytes_mismatch", "the stored file is not a PNG, JPEG or WebP image");
    const measured = { content_hash: await sha256Hex(read.bytes), ...meta };

    return execute(id, receipt, measured);
  }

  // The copy, checked here against the post's own rebuilt brief; the
  // database refuses anything not checked clean, or not the receipt's copy.
  async function reviseCopy(p: Json, id: string, receipt: Json,
                            refuse: (code: string, message: string, extra?: Json) => Promise<Response>): Promise<Response> {
    if (!deps.copyCheck) return refuse("copy_check_unavailable", "this deployment cannot check copy; nothing was changed");
    const change = p.change as { copy: string; claim_ids: string[] };
    let checked: CopyCheckResult;
    try {
      checked = await deps.copyCheck(p.client_id as string, (p.post as Json).id as string, change.copy, change.claim_ids);
    } catch {
      return reply(503, { error: "outcome_unknown", message: "The copy check did not confirm; retry with the same operation_id.", receipt });
    }
    if (!checked.ok) return refuse(checked.code, checked.message, { problems: checked.problems });
    return execute(id, receipt, { lint_ok: true, brief_hash: checked.brief_hash, checked_copy: change.copy, warnings: checked.warnings });
  }

  async function execute(id: string, receipt: Json, measured: Json): Promise<Response> {
    const ex = await store.editExecute(id, measured).catch(unconfirmed);
    if (ex.error) {
      if (ex.error.code && REFUSAL.test(ex.error.code)) {
        // The transaction rolled back: nothing was withdrawn, replaced or resubmitted.
        const code = refusalCode(ex.error.message);
        const refused = await store.editRefuse(id, code, ex.error.message);
        return reply(422, { error: code, message: ex.error.message, receipt: refused.data ?? receipt });
      }
      return reply(503, { error: "outcome_unknown", message: "Execution did not confirm; check revise_status or retry with the same operation_id.", receipt });
    }
    return reply(201, { receipt: ex.data, replayed: false });
  }

  return { handle };
}
