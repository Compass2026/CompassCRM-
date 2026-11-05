// claim-evidence — uploads and checks claim evidence files (20261104200000).
//
// ChatGPT's PR2 review: authoritative evidence is a privately uploaded file,
// pinned to an immutable, verifiable reference with a SHA-256. The browser
// never writes the claim-evidence bucket (it has no write policy) and its
// hash is never trusted: this function signs a one-time upload for exactly
// the content address <client_id>/<sha256>.<ext>, then downloads what was
// stored, recomputes the SHA-256 and checks the file type from its bytes
// before claim_evidence_register records anything. A file whose bytes do not
// match its address is deleted. A registered file cannot be replaced or
// deleted (a trigger on storage.objects).
//
// Provenance: prepare records the upload request from the caller's OWN
// session (claim_evidence_request_upload, called with their JWT, so the
// database stamps the requester itself), and finalize registers the file
// against that request with the service role. claim_evidence_register is
// executable by the service role, which every Edge Function holds; it takes
// the uploader from the request, never from an argument.
//
// Auth: a team JWT only (401 without a session, 403 for anyone not on
// team_members). There is no cron path: no automation uploads evidence.
// Uploading decides nothing; only the verification owner, signed in, can cite
// a file in a decision (claim_verify).
//
// Body (POST, JSON):
//   { mode: "prepare",  client_id, sha256, size, mime_type }
//       → { status: "exists", evidence }      the same bytes are already registered for this client
//       → { status: "upload", path, token, upload_id }   upload the file to `path` with `token` (storage-js uploadToSignedUrl)
//       → { status: "uploaded", path, upload_id }        a file is already stored there unregistered: finalize it
//   { mode: "finalize", client_id, upload_id, path, evidence_type, label, original_name?, source_url?, captured_on? }
//       → { status: "registered", evidence }  (422 with the reason when the bytes or the record are refused)
//   { mode: "check", evidence_id }
//       → { status: "intact" | "mismatch" | "missing", sha256, actual_sha256?, checked_at }
//
// This file is the handler; index.ts wires the real Supabase client.
// tests/claim-evidence-handler.test.mjs drives it with a fake one.

// deno-lint-ignore no-explicit-any
export type SupabaseLike = any;

export interface ClaimEvidenceDeps {
  /** A service-role client. */
  supabase: SupabaseLike;
  /** A client that acts as the caller: their JWT on every request (role authenticated). */
  userClient: (jwt: string) => SupabaseLike;
  now?: () => Date;
  maxBytes?: number;
}

export const BUCKET = "claim-evidence";
export const MAX_BYTES = 10 * 1024 * 1024;
export const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const EVIDENCE_COLUMNS =
  "id, client_id, evidence_type, label, storage_path, sha256, size_bytes, mime_type, original_name, source_url, captured_on, uploaded_by, created_at";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The type a file's first bytes say it is: PDF, PNG, JPEG or WebP, else null. */
export function sniffMime(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 5 && at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function evidencePath(clientId: string, sha256: string, mime: string): string {
  return `${clientId}/${sha256}.${MIME_EXT[mime]}`;
}

/** The client id, hash and extension a content address names, or null. */
export function parsePath(path: string): { clientId: string; sha256: string; ext: string } | null {
  const m = /^([0-9a-f-]{36})\/([0-9a-f]{64})\.(pdf|png|jpg|webp)$/.exec(path);
  return m && UUID.test(m[1]) ? { clientId: m[1], sha256: m[2], ext: m[3] } : null;
}

function chicagoToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}

export function createClaimEvidenceHandler(deps: ClaimEvidenceDeps) {
  const max = deps.maxBytes ?? MAX_BYTES;
  const now = deps.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const supabase = deps.supabase;

    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData } = await supabase.auth.getUser(jwt);
    if (!userData?.user) return json({ error: "unauthorized" }, 401);
    const { data: member } = await supabase
      .from("team_members")
      .select("id")
      .eq("auth_user_id", userData.user.id)
      .maybeSingle();
    if (!member) return json({ error: "forbidden" }, 403);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "a JSON body is required" }, 400);
    const storage = supabase.storage.from(BUCKET);

    // ── check: re-hash a registered file ─────────────────────────────────────
    if (body.mode === "check") {
      if (!UUID.test(String(body.evidence_id ?? ""))) return json({ error: "evidence_id is required" }, 400);
      const { data: ev } = await supabase.from("claim_evidence").select(EVIDENCE_COLUMNS).eq("id", body.evidence_id).maybeSingle();
      if (!ev) return json({ error: "evidence not found" }, 404);
      const checked_at = now().toISOString();
      const { data: blob, error } = await storage.download(ev.storage_path);
      if (error || !blob) return json({ status: "missing", sha256: ev.sha256, checked_at });
      const actual = await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
      return json({ status: actual === ev.sha256 ? "intact" : "mismatch", sha256: ev.sha256, actual_sha256: actual, checked_at });
    }

    const clientId = String(body.client_id ?? "");
    if (!UUID.test(clientId)) return json({ error: "client_id is required" }, 400);
    const { data: client } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
    if (!client) return json({ error: "client not found" }, 404);

    // ── prepare: a one-time upload for exactly the content address ──────────
    if (body.mode === "prepare") {
      const sha = String(body.sha256 ?? "").toLowerCase();
      const size = Number(body.size);
      const mime = String(body.mime_type ?? "");
      if (!SHA.test(sha)) return json({ error: "sha256 must be 64 hex characters" }, 400);
      if (!MIME_EXT[mime]) return json({ error: "Evidence must be a PDF, PNG, JPEG or WebP file" }, 400);
      if (!Number.isInteger(size) || size < 1 || size > max) {
        return json({ error: `Evidence files are 1 byte to ${Math.round(max / 1024 / 1024)} MB` }, 400);
      }
      const { data: existing } = await supabase
        .from("claim_evidence")
        .select(EVIDENCE_COLUMNS)
        .eq("client_id", clientId)
        .eq("sha256", sha)
        .maybeSingle();
      if (existing) return json({ status: "exists", evidence: existing });
      // The request is written from the caller's own session: the database
      // records who asked, from their JWT, not from anything sent here.
      const { data: uploadId, error: reqError } = await deps.userClient(jwt).rpc("claim_evidence_request_upload", {
        p_client_id: clientId,
        p_sha256: sha,
        p_size: size,
        p_mime: mime,
      });
      if (reqError || !uploadId) {
        const status = reqError?.code === "42501" ? 403 : 422;
        return json({ error: reqError?.message ?? "The upload request was refused" }, status);
      }
      const path = evidencePath(clientId, sha, mime);
      const { data: signed, error } = await storage.createSignedUploadUrl(path);
      if (error || !signed?.token) {
        // An earlier attempt stored the file and stopped before finalize.
        if (/exist|duplicate/i.test(error?.message ?? "")) return json({ status: "uploaded", path, upload_id: uploadId });
        return json({ error: `Could not prepare the upload: ${error?.message ?? "no token"}` }, 502);
      }
      return json({ status: "upload", path, token: signed.token, upload_id: uploadId });
    }

    // ── finalize: re-hash what was stored, then register it ─────────────────
    if (body.mode === "finalize") {
      const path = String(body.path ?? "");
      const parsed = parsePath(path);
      if (!parsed || parsed.clientId !== clientId) return json({ error: "path must be <client_id>/<sha256>.<ext>" }, 400);
      const uploadId = String(body.upload_id ?? "");
      if (!UUID.test(uploadId)) return json({ error: "upload_id is required" }, 400);
      const { data: request } = await supabase
        .from("claim_evidence_uploads")
        .select("id, client_id, sha256, mime_type, requested_by")
        .eq("id", uploadId)
        .maybeSingle();
      if (!request || request.client_id !== clientId || request.sha256 !== parsed.sha256 || MIME_EXT[request.mime_type] !== parsed.ext) {
        return json({ error: "No upload request for that file" }, 404);
      }
      if (request.requested_by !== member.id) return json({ error: "Another teammate asked to upload that file" }, 403);
      const type = body.evidence_type;
      if (type !== "document" && type !== "capture") return json({ error: "evidence_type is document or capture" }, 400);
      const label = String(body.label ?? "").trim();
      if (label.length < 1 || label.length > 200) return json({ error: "A label of up to 200 characters is required" }, 400);
      let sourceUrl: string | null = null;
      let capturedOn: string | null = null;
      if (type === "capture") {
        sourceUrl = String(body.source_url ?? "").trim();
        capturedOn = String(body.captured_on ?? "");
        if (!/^https?:\/\/[^/\s?#]+/.test(sourceUrl) || sourceUrl.length > 2000) {
          return json({ error: "A capture needs the http(s) address of the page it records" }, 400);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(capturedOn) || capturedOn > chicagoToday(now())) {
          return json({ error: "A capture needs the day it was captured (not a future day)" }, 400);
        }
      }
      const originalName = body.original_name ? String(body.original_name).slice(0, 200) : null;

      const { data: blob, error: dlError } = await storage.download(path);
      if (dlError || !blob) return json({ error: "No file was uploaded to that address" }, 404);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const discard = async (reason: string) => {
        await storage.remove([path]);
        return json({ error: reason }, 422);
      };
      if (bytes.length < 1 || bytes.length > max) return discard("The stored file is empty or too large");
      const actual = await sha256Hex(bytes);
      if (actual !== parsed.sha256) return discard("The stored bytes do not match the address they were uploaded to; upload again");
      const mime = sniffMime(bytes);
      if (!mime || MIME_EXT[mime] !== parsed.ext) {
        return discard("The file is not the PDF, PNG, JPEG or WebP its name says it is");
      }

      const { data: evidence, error: regError } = await supabase.rpc("claim_evidence_register", {
        p_upload_id: uploadId,
        p_storage_path: path,
        p_sha256: actual,
        p_size: bytes.length,
        p_mime: mime,
        p_evidence_type: type,
        p_label: label,
        p_original_name: originalName,
        p_source_url: sourceUrl,
        p_captured_on: capturedOn,
      });
      if (regError || !evidence) {
        // The file is not evidence until registered; do not leave it behind.
        return discard(regError?.message ?? "The evidence could not be registered");
      }
      return json({ status: "registered", evidence });
    }

    return json({ error: "mode is prepare, finalize or check" }, 400);
  };
}
