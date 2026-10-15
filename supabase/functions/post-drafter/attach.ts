// attach_photo (20261015060000): the request, the hash and the reply. Pure,
// so the unit tests exercise them without a database.
import type { WriteError } from "./store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION = /^[A-Za-z0-9_-]{8,128}$/;

export type AttachRequest = {
  post_id: string;
  brand_asset_id: string;
  operation_id: string;
  expected_updated_at: string | null;
  runtime: string;
};

// The caller names the post and the photo and says which version of the post
// it read. It never names the client: that is the post's own.
export function parseAttach(body: Record<string, unknown>): AttachRequest | string {
  if ("client_id" in body) return "client_id is not accepted: the client is the post's own";
  const { post_id, brand_asset_id, operation_id, expected_updated_at, runtime } = body;
  if (typeof post_id !== "string" || !UUID.test(post_id)) return "post_id must be a uuid";
  if (typeof brand_asset_id !== "string" || !UUID.test(brand_asset_id)) return "brand_asset_id must be a uuid";
  if (typeof operation_id !== "string" || !OPERATION.test(operation_id)) return "operation_id is 8-128 letters, digits, _ or -";
  if (!("expected_updated_at" in body)) return "expected_updated_at is required (the post's updated_at as read; null when never updated)";
  if (expected_updated_at !== null && (typeof expected_updated_at !== "string" || Number.isNaN(Date.parse(expected_updated_at)))) {
    return "expected_updated_at is a timestamp or null";
  }
  const label = typeof runtime === "string" ? runtime.trim() : "";
  if (label.length < 1 || label.length > 80) return "runtime (a 1-80 character label for the operator) is required";
  return { post_id, brand_asset_id, operation_id, expected_updated_at: expected_updated_at as string | null, runtime: label };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// drafter_attach_photo's codes: 42501 caller, P0002 not found, DR409 state /
// staleness / media already there / reused operation, DR422 an ineligible
// post or photo, 23514 a bad request or a grounding refusal on resubmit.
// Each message starts with a stable code word.
export function attachReply(result: Record<string, unknown> | { error: WriteError }): { status: number; body: Record<string, unknown> } {
  if (!("error" in result)) {
    return { status: result.status === "attached" && !result.replayed ? 201 : 200, body: result };
  }
  const e = result.error as WriteError;
  const word = /^([a-z_]+):\s*(.*)$/s.exec(e.message);
  const code = word?.[1] ?? null;
  const message = word?.[2] ?? e.message;
  switch (e.code) {
    case "42501": return { status: 403, body: { error: "forbidden", message } };
    case "P0002": return { status: 404, body: { error: code ?? "not_found", message } };
    case "DR409": return { status: 409, body: { error: code ?? "conflict", message } };
    case "DR422": return { status: 422, body: { error: code ?? "ineligible", message } };
    case "23514":
      return code === "bad_request"
        ? { status: 400, body: { error: "bad_request", message } }
        : { status: 422, body: { error: "grounding", message: e.message } };
    default: return { status: 500, body: { error: "attach_failed", code: e.code, message: e.message } };
  }
}
