// content-approvals — delegated approval and publication of blog drafts
// (20261019190532) and Facebook / Business Profile posts (20261019230000). Executive OS is the only caller: it holds the owner's
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
// Auth: the x-compass-delegation-key header must equal the Vault secret
// EXECUTIVE_OS_DELEGATION_SECRET (constant-time). Nothing else is accepted —
// not a team JWT, not the cron secret. Executive OS never touches the database.
//
// Outcome honesty: a PostgREST error with a SQLSTATE proves the function ran
// and rolled back (refused). Anything else (network, timeout) is UNKNOWN: the
// caller retries with the SAME operation_id, which returns the receipt and
// never executes twice.

export const HANDLER_VERSION = 2;
export const MODES = ["version", "batch", "authorize", "status"] as const;
const ACTIONS = ["approve", "publish", "approve_and_publish"] as const;
const CHANNELS = ["chatgpt", "claude"] as const;
export const CONTENT_CHANNELS = ["blog", "facebook", "google_business"] as const;
const MAX_ITEMS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

type Json = Record<string, unknown>;
export type DbError = { code: string | null; message: string };
export type DbResult<T> = { data: T | null; error: DbError | null };

export type Store = {
  secret(name: string): Promise<string | null>;
  clientsNamed(name: string): Promise<{ id: string; name: string }[]>;
  batch(clientId: string, channel: string | null): Promise<DbResult<Json>>;
  record(p: Json): Promise<DbResult<Json>>;
  execute(id: string): Promise<DbResult<Json>>;
  refuse(id: string, code: string, message: string): Promise<DbResult<Json>>;
  status(operationId: string): Promise<DbResult<Json>>;
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

export function createContentApprovals(deps: { store: Store }) {
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
      return reply(200, { version: HANDLER_VERSION, modes: MODES, actions: ACTIONS, channels: CHANNELS, content_channels: CONTENT_CHANNELS });
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

    return reply(400, { error: `mode is one of ${MODES.join(", ")}` });
  }

  return { handle };
}
