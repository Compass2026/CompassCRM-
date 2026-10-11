// creative-lab: the Creative Lab's one server-side door (Preview Mode,
// Oct 8 2026; docs/creative-lab.md). It writes nothing, anywhere.
//
//   version   what this deployment does.
//   sources   short-lived (5 minute) signed download links for the stored bytes
//             of one client's renderable sources: brand assets a teammate
//             approved for creative use, with a recorded hash and a stored
//             file, minus people imagery (govern.ts refuses it) and logos that
//             are not the primary approved mark. The lab renders previews from
//             these with the same engine and governance as the Creative Engine
//             (scripts/creative-lab.mjs), re-hashing every file against the
//             reviewed hash.
//
// Preview Mode removes approval friction from exploration only: no template
// registration or client approval is needed to look at a preview, but every
// word on an image is still resolved from the governed record and every photo
// is still an approved own-work file. Nothing here can create, approve,
// schedule or publish anything; promotion goes through the AI Drafter and the
// post review gate as before.
//
// Callers: a signed-in teammate (team JWT) or the operator door (x-cron-secret).

// The same rule as creative-engine/govern.ts PEOPLE_SUBJECTS (a test pins the
// two together); copied so this function deploys without the renderer.
export const PEOPLE_SUBJECTS = /\b(owner|team member|team|crew|staff|employee|people|person|customer|homeowner|worker|family|child|children|portrait|headshot)\b/i;

export const LAB_VERSION = 1;
export const MODES = ["version", "sources"] as const;
export const SIGNED_URL_SECONDS = 300;

export type LabAsset = {
  id: string; kind: string; label: string | null; creative_use: string; depicts_own_work: boolean | null;
  subjects: string[]; focal_x: number | null; focal_y: number | null; width: number | null; height: number | null;
  content_hash: string | null; storage_path: string | null;
};

export type Store = {
  secret(name: string): Promise<string | null>;
  caller(jwt: string): Promise<"none" | { member: string | null }>;
  client(clientId: string): Promise<{ id: string; status: string } | null>;
  assets(clientId: string): Promise<LabAsset[]>;
  sign(storagePath: string, seconds: number): Promise<string>;
};

type Json = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status: number, body: Json) => Response.json(body, { status });

// The sources a lab render may use: approved, hashed, stored; photos without
// people; the primary logo.
export function renderable(a: LabAsset): boolean {
  if (a.creative_use !== "approved" || !a.content_hash || !a.storage_path) return false;
  if (a.kind === "photo") return !a.subjects.some((s) => PEOPLE_SUBJECTS.test(s));
  return a.kind === "logo_primary";
}

export function createCreativeLab({ store }: { store: Store }) {
  async function caller(req: Request): Promise<"worker" | "team" | 401 | 403> {
    const cron = await store.secret("SYNC_CRON_SECRET");
    const header = req.headers.get("x-cron-secret");
    if (cron && header && header === cron) return "worker";
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const who = await store.caller(jwt);
    if (who === "none") return 401;
    if (!who.member) return 403;
    return "team";
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const who = await caller(req);
    if (who === 401) return reply(401, { error: "unauthorized" });
    if (who === 403) return reply(403, { error: "forbidden: team members only" });
    let body: Json;
    try {
      body = await req.json();
    } catch {
      return reply(400, { error: "JSON body required" });
    }
    const mode = body?.mode;
    if (!MODES.includes(mode as typeof MODES[number])) return reply(400, { error: `mode must be one of ${MODES.join(", ")}` });
    for (const k of Object.keys(body)) {
      if (!["mode", "client_id"].includes(k)) return reply(400, { error: `unknown field ${k}` });
    }
    if (mode === "version") return reply(200, { version: LAB_VERSION, modes: MODES, writes: false, signed_url_seconds: SIGNED_URL_SECONDS });

    const clientId = String(body.client_id ?? "");
    if (!UUID.test(clientId)) return reply(400, { error: "client_id is required" });
    const client = await store.client(clientId);
    if (!client) return reply(404, { error: "no such client" });
    if (client.status === "offboarded") return reply(409, { error: "the client is offboarded" });

    const sources = [];
    for (const a of (await store.assets(clientId)).filter(renderable)) {
      sources.push({
        id: a.id, kind: a.kind, label: a.label, depicts_own_work: a.depicts_own_work, subjects: a.subjects,
        focal_x: a.focal_x, focal_y: a.focal_y, width: a.width, height: a.height, content_hash: a.content_hash,
        url: await store.sign(a.storage_path!, SIGNED_URL_SECONDS),
      });
    }
    return reply(200, { mode, writes: false, client_id: clientId, expires_in: SIGNED_URL_SECONDS, sources });
  }

  return { handle };
}
