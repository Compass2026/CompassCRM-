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
// It reads image bytes and never writes them: no upload, no transformation,
// no path change. It never touches review fields (creative_use, own work,
// subjects, focal point); only a teammate sets those. Link-only assets are
// reported with the brand-scan import that would store them.
//
// Callers: the worker (x-cron-secret = SYNC_CRON_SECRET) or a signed-in team
// member (JWT on team_members). Deployed with verify_jwt = true.
import { importSuggestion, inspect, summarize, type AssetRow, type Entry, type Read } from "./plan.ts";

export const HANDLER_VERSION = 1;
export const MODES = ["version", "inventory", "hash"] as const;
export const MAX_ASSETS = 60;

export type Store = {
  secret(name: string): Promise<string | null>;
  caller(jwt: string): Promise<"none" | { member: string | null }>;
  client(id: string): Promise<{ id: string; name: string } | null>;
  assets(clientId: string): Promise<AssetRow[]>;
  read(storagePath: string): Promise<Read>;
  record(p: Record<string, unknown>): Promise<Record<string, unknown>>;
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

  return { handle };
}
