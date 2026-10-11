// source-assets (Source Asset Governance, 0055): hashes and measures the
// stored files of a client's brand assets.
//
//   version    → what this deployment is.
//   inventory  → read-only dry run: every asset of the client, whether its
//                file is stored, what the bytes measure and what recording
//                them would change. Writes nothing.
//   hash       → records the measurement for the assets named in `expect`,
//                each bound to the hash the inventory reported
//                ({asset_id: content_hash}). The file is read again; bytes
//                that no longer hash to the expected value are refused, never
//                recorded. Every write is brand_asset_record_hash (a
//                compare-and-set on the path and the previous hash).
//
//   upload_slot → (v2) a signed, single-use upload URL per file for the
//                content address <client>/upload/<sha256>.<ext> in the private
//                brand-assets bucket. Writes no row; an object already there
//                is reported, never overwritten.
//   register    → (v2) files an uploaded object as a new brand asset: the
//                stored bytes are read back and must hash to the address,
//                the row is inserted (unreviewed) with its provenance in the
//                notes, and the hash is recorded through
//                brand_asset_record_hash. Idempotent on the path.
//
// Apart from upload_slot it never writes image bytes: no transformation, no
// path change, no delete. It never touches review fields (creative_use, own
// work, subjects, focal point); only a teammate sets those, so a registered
// file is unreviewed until a teammate approves it on Brand › Creative use.
// register files generated graphics only (kind social_post): a picture made
// by a tool is never a photo of the client's work, never a claim, source or
// evidence, and the notes say so. Link-only assets are reported with the
// brand-scan import that would store them.
//
// Callers: the worker (x-cron-secret = SYNC_CRON_SECRET) or a signed-in team
// member (JWT on team_members). Deployed with verify_jwt = true.
import { importSuggestion, inspect, summarize, type AssetRow, type Entry, type Read } from "./plan.ts";

export const HANDLER_VERSION = 2;
export const MODES = ["version", "inventory", "hash", "upload_slot", "register"] as const;
export const MAX_ASSETS = 60;
export const MAX_UPLOADS = 12;
// What register files, and how the provenance reads on the asset.
export const REGISTER_KINDS = ["social_post"] as const;
export const PROVENANCE = {
  ai_generated: (tool: string) =>
    `${tool}-generated / non-evidentiary visual. Illustrative only: not a photo of the client's work, ` +
    `and never a claim, a source or E-E-A-T evidence because it exists.`,
} as const;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const uploadPath = (clientId: string, sha256: string, contentType: string) =>
  `${clientId}/upload/${sha256}.${EXT[contentType]}`;

export type Store = {
  secret(name: string): Promise<string | null>;
  caller(jwt: string): Promise<"none" | { member: string | null }>;
  client(id: string): Promise<{ id: string; name: string } | null>;
  assets(clientId: string): Promise<AssetRow[]>;
  read(storagePath: string): Promise<Read>;
  record(p: Record<string, unknown>): Promise<Record<string, unknown>>;
  uploadSlot(storagePath: string): Promise<{ exists: true } | { exists: false; signed_url: string; token: string }>;
  insertAsset(row: Record<string, unknown>): Promise<AssetRow>;
};

type Json = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const reply = (status: number, body: Json) => Response.json(body, { status });
// Database refusals come back as "code: message"; keep the code.
const refusal = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return { code: (m.match(/^([a-z_]+):/) ?? [])[1] ?? "refused", detail: m.slice(0, 300) };
};

export function createSourceAssets({ store }: { store: Store }) {
  async function caller(req: Request): Promise<{ via: "worker" | "team"; member: string | null } | 401 | 403> {
    const cron = await store.secret("SYNC_CRON_SECRET");
    const header = req.headers.get("x-cron-secret");
    if (cron && header && header === cron) return { via: "worker", member: null };
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const who = await store.caller(jwt);
    if (who === "none") return 401;
    if (!who.member) return 403;
    return { via: "team", member: who.member };
  }

  async function entries(rows: AssetRow[]): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const row of rows) {
      out.push(await inspect(row, row.storage_path ? await store.read(row.storage_path) : null));
    }
    return out;
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const who = await caller(req);
    if (who === 401) return reply(401, { error: "unauthorized" });
    if (who === 403) return reply(403, { error: "forbidden: team only" });

    const body = (await req.json().catch(() => null)) as Json | null;
    const mode = body?.mode;
    if (!MODES.includes(mode as typeof MODES[number])) return reply(400, { error: `mode must be one of ${MODES.join(", ")}` });
    if (mode === "version") return reply(200, { version: HANDLER_VERSION, modes: MODES, max_assets: MAX_ASSETS });

    const clientId = String(body?.client_id ?? "");
    if (!UUID.test(clientId)) return reply(400, { error: "client_id is required" });
    const client = await store.client(clientId);
    if (!client) return reply(404, { error: "no such client" });
    const rows = await store.assets(clientId);

    if (mode === "upload_slot") return uploadSlots(body!, clientId);
    if (mode === "register") return register(body!, client, rows, who.via);

    if (mode === "inventory") {
      if (rows.length > MAX_ASSETS) return reply(413, { error: `more than ${MAX_ASSETS} assets; not supported in one call` });
      const list = await entries(rows);
      return reply(200, {
        mode, writes: false, client: { id: client.id, name: client.name },
        summary: summarize(list), assets: list, link_only_import: importSuggestion(rows),
      });
    }

    // hash: only the assets the caller names, each bound to its inventoried hash.
    const expect = body?.expect;
    if (!expect || typeof expect !== "object" || Array.isArray(expect)) {
      return reply(400, { error: "hash needs expect: {asset_id: content_hash} from an inventory" });
    }
    const wanted = Object.entries(expect as Record<string, unknown>);
    if (!wanted.length || wanted.length > MAX_ASSETS) return reply(400, { error: `expect names 1–${MAX_ASSETS} assets` });
    if (wanted.some(([id, h]) => !UUID.test(id) || typeof h !== "string" || !HEX.test(h))) {
      return reply(400, { error: "expect maps asset ids to sha256 hex digests" });
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const results: Json[] = [];
    for (const [id, expected] of wanted) {
      const row = byId.get(id);
      if (!row) { results.push({ asset_id: id, status: "refused", code: "not_this_client" }); continue; }
      const e = await inspect(row, row.storage_path ? await store.read(row.storage_path) : null);
      if (!e.measured) { results.push({ asset_id: id, status: "refused", code: e.issues[0]?.code ?? "unreadable", issues: e.issues }); continue; }
      if (e.measured.content_hash !== expected) {
        results.push({ asset_id: id, status: "refused", code: "changed_since_inventory", measured: e.measured.content_hash });
        continue;
      }
      if (e.action === "unchanged") { results.push({ asset_id: id, status: "unchanged", content_hash: expected }); continue; }
      try {
        const r = await store.record({
          asset_id: id, storage_path: row.storage_path, expected_hash: row.content_hash,
          content_hash: e.measured.content_hash, width: e.measured.width, height: e.measured.height,
          byte_size: e.measured.bytes, content_type: e.measured.content_type,
          raw_width: e.measured.raw_width, raw_height: e.measured.raw_height, orientation: e.measured.orientation,
          measured_by: `source-assets/${HANDLER_VERSION}`,
        });
        results.push({ ...r, issues: e.issues });
      } catch (err) {
        results.push({ asset_id: id, status: "refused", ...refusal(err) });
      }
    }
    const count = (s: string) => results.filter((r) => r.status === s).length;
    return reply(200, {
      mode, writes: true, client: { id: client.id, name: client.name }, requested_via: who.via,
      summary: { requested: wanted.length, recorded: results.length - count("unchanged") - count("refused"), unchanged: count("unchanged"), refused: count("refused") },
      results,
    });
  }

  // upload_slot: {files: [{sha256, content_type}]}. Writes no row.
  async function uploadSlots(body: Json, clientId: string): Promise<Response> {
    const files = body.files;
    if (!Array.isArray(files) || !files.length || files.length > MAX_UPLOADS) {
      return reply(400, { error: `files lists 1–${MAX_UPLOADS} {sha256, content_type}` });
    }
    const bad = files.find((f) => !f || !HEX.test(String(f.sha256 ?? "")) || !EXT[String(f.content_type ?? "")]);
    if (bad) return reply(400, { error: "each file needs a sha256 hex digest and a content_type of image/png, image/jpeg or image/webp" });
    const slots: Json[] = [];
    for (const f of files as Json[]) {
      const path = uploadPath(clientId, String(f.sha256), String(f.content_type));
      const s = await store.uploadSlot(path);
      slots.push(s.exists ? { sha256: f.sha256, storage_path: path, status: "exists" }
        : { sha256: f.sha256, storage_path: path, status: "ready", signed_url: s.signed_url, token: s.token });
    }
    return reply(200, { mode: "upload_slot", writes: false, bucket: "brand-assets", slots });
  }

  // register: {files: [{sha256, content_type, file_name, label, kind, provenance: {origin, tool, source_ref}}]}.
  async function register(body: Json, client: { id: string; name: string }, rows: AssetRow[], via: string): Promise<Response> {
    const files = body.files;
    if (!Array.isArray(files) || !files.length || files.length > MAX_UPLOADS) {
      return reply(400, { error: `files lists 1–${MAX_UPLOADS} uploads to register` });
    }
    for (const f of files as Json[]) {
      const p = (f?.provenance ?? {}) as Json;
      const ok = HEX.test(String(f?.sha256 ?? "")) && EXT[String(f?.content_type ?? "")]
        && typeof f.label === "string" && f.label.trim().length > 0 && f.label.length <= 200
        && typeof f.file_name === "string" && /^[\w.\- ]{1,200}$/.test(f.file_name)
        && REGISTER_KINDS.includes(f.kind as typeof REGISTER_KINDS[number])
        && p.origin === "ai_generated" && typeof p.tool === "string" && /^[\w .-]{1,40}$/.test(p.tool)
        && (p.source_ref == null || (typeof p.source_ref === "string" && p.source_ref.length <= 300));
      if (!ok) {
        return reply(400, {
          error: `each file needs sha256, content_type, file_name, label, kind (${REGISTER_KINDS.join(", ")}) ` +
            `and provenance {origin: "ai_generated", tool, source_ref?}`,
        });
      }
    }
    const byPath = new Map(rows.filter((r) => r.storage_path).map((r) => [r.storage_path!, r]));
    const results: Json[] = [];
    for (const f of files as Json[]) {
      const sha = String(f.sha256);
      const path = uploadPath(client.id, sha, String(f.content_type));
      const read = await store.read(path);
      if (!read.ok) { results.push({ sha256: sha, storage_path: path, status: "refused", code: read.reason === "missing" ? "not_uploaded" : read.reason }); continue; }
      let row = byPath.get(path) ?? null;
      const probe = await inspect(row ?? {
        id: "", client_id: client.id, kind: String(f.kind), source: "upload", label: String(f.label), storage_path: path,
        url: null, mime_type: null, size_bytes: null, width: null, height: null, content_hash: null, creative_use: "unreviewed",
      }, read);
      const m = probe.measured;
      if (!m) { results.push({ sha256: sha, storage_path: path, status: "refused", code: probe.issues[0]?.code ?? "unreadable" }); continue; }
      if (m.content_hash !== sha) { results.push({ sha256: sha, storage_path: path, status: "refused", code: "hash_mismatch", measured: m.content_hash }); continue; }
      if (m.content_type !== f.content_type) { results.push({ sha256: sha, storage_path: path, status: "refused", code: "type_mismatch", measured: m.content_type }); continue; }
      try {
        const existed = !!row;
        if (!row) {
          const p = f.provenance as Json;
          const notes = [PROVENANCE.ai_generated(String(p.tool)),
            p.source_ref ? `Source: ${p.source_ref} (${f.file_name}).` : `File: ${f.file_name}.`,
            `Filed by source-assets/${HANDLER_VERSION}.`].join(" ");
          row = await store.insertAsset({
            client_id: client.id, kind: f.kind, source: "upload", label: String(f.label).trim(), storage_path: path,
            file_name: f.file_name, mime_type: m.content_type, size_bytes: m.bytes, width: m.width, height: m.height,
            notes, uploaded_by: `source-assets/${HANDLER_VERSION} (${via})`,
          });
          byPath.set(path, row);
        }
        if (row.content_hash === sha) {
          results.push({ sha256: sha, storage_path: path, asset_id: row.id, status: "unchanged", width: m.width, height: m.height });
          continue;
        }
        const r = await store.record({
          asset_id: row.id, storage_path: path, expected_hash: row.content_hash,
          content_hash: sha, width: m.width, height: m.height, byte_size: m.bytes, content_type: m.content_type,
          raw_width: m.raw_width, raw_height: m.raw_height, orientation: m.orientation,
          measured_by: `source-assets/${HANDLER_VERSION}`,
        });
        results.push({ ...r, sha256: sha, storage_path: path, asset_id: row.id, status: existed ? "hashed" : "registered", width: m.width, height: m.height, bytes: m.bytes });
      } catch (err) {
        results.push({ sha256: sha, storage_path: path, asset_id: row?.id ?? null, status: "refused", ...refusal(err) });
      }
    }
    const count = (s: string) => results.filter((r) => r.status === s).length;
    return reply(200, {
      mode: "register", writes: true, client: { id: client.id, name: client.name }, requested_via: via,
      summary: { requested: files.length, registered: count("registered"), hashed: count("hashed"), unchanged: count("unchanged"), refused: count("refused") },
      results,
    });
  }

  return { handle };
}
