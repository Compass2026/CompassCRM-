// source-assets: what one brand asset's stored file is, and what recording
// it would change. Pure: it is given the row and the bytes (or why there are
// none) and returns an inventory entry. Nothing here writes.
import { measure, sha256Hex } from "../_shared/image-meta.ts";

export const MAX_BYTES = 30 * 1024 * 1024;

export type AssetRow = {
  id: string;
  client_id: string;
  kind: string;
  source: string;
  label: string;
  storage_path: string | null;
  url: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  content_hash: string | null;
  creative_use: string;
};

export type Read =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "missing" | "unreadable" | "too_large"; detail?: string };

export type Measured = {
  content_hash: string;
  content_type: string;
  bytes: number;
  width: number;
  height: number;
  raw_width: number;
  raw_height: number;
  orientation: number;
};

export type Issue = { code: string; detail: string };

export type Entry = {
  asset_id: string;
  kind: string;
  source: string;
  label: string;
  storage_path: string | null;
  url: string | null;
  creative_use: string;
  stored: "present" | "missing" | "unreadable" | "too_large" | "no_file";
  recorded: { width: number | null; height: number | null; size_bytes: number | null; mime_type: string | null; content_hash: string | null };
  measured: Measured | null;
  action: "record" | "unchanged" | "skip";
  changes: string[];
  issues: Issue[];
  review_reset: boolean;
};

const short = (h: string | null) => (h ? `${h.slice(0, 12)}…` : "none");

// A link-only asset has no stored file: it is reported, never hashed as if it
// were one. brand-scan's import mode stores it (a new row with a stored file)
// and can remove the link row in the same call.
export function importSuggestion(rows: AssetRow[]) {
  const links = rows.filter((r) => !r.storage_path && r.url);
  if (!links.length) return null;
  return {
    function: "brand-scan",
    body: {
      client_id: links[0].client_id,
      import: links.map((r) => ({ url: r.url, kind: r.kind, label: r.label })),
      remove: links.map((r) => r.id),
    },
    note: "Stores each linked image as a new brand asset (unreviewed, unhashed) and deletes the link-only row; hash the new rows afterwards.",
  };
}

export async function inspect(row: AssetRow, read: Read | null): Promise<Entry> {
  const base = {
    asset_id: row.id, kind: row.kind, source: row.source, label: row.label,
    storage_path: row.storage_path, url: row.url, creative_use: row.creative_use,
    recorded: { width: row.width, height: row.height, size_bytes: row.size_bytes, mime_type: row.mime_type, content_hash: row.content_hash },
  };
  if (!row.storage_path) {
    return {
      ...base, stored: "no_file", measured: null, action: "skip", changes: [], review_reset: false,
      issues: [row.url
        ? { code: "link_only", detail: "Only a link is recorded; there are no stored bytes to hash. Import it with brand-scan first." }
        : { code: "no_file", detail: "Neither a stored file nor a link is recorded." }],
    };
  }
  if (!read || !read.ok) {
    const reason = read?.reason ?? "missing";
    const detail = reason === "missing" ? "The stored file is not in the brand-assets bucket."
      : reason === "too_large" ? `The stored file is larger than ${MAX_BYTES} bytes.`
      : `The stored file could not be read${read && !read.ok && read.detail ? `: ${read.detail}` : ""}.`;
    return {
      ...base, stored: reason, measured: null, action: "skip", changes: [], review_reset: false,
      issues: [{ code: reason === "missing" ? "object_missing" : reason, detail }],
    };
  }

  const meta = measure(read.bytes);
  const content_hash = await sha256Hex(read.bytes);
  if (!meta) {
    return {
      ...base, stored: "present", measured: null, action: "skip", changes: [], review_reset: false,
      issues: [{ code: "unsupported_type", detail: `Not a PNG, JPEG, GIF or WebP this can measure (sha256 ${short(content_hash)}).` }],
    };
  }
  const measured: Measured = { content_hash, ...meta };
  const issues: Issue[] = [];
  const changes: string[] = [];
  if (row.content_hash !== content_hash) changes.push(`content_hash: ${short(row.content_hash)} → ${short(content_hash)}`);
  if (row.width !== meta.width) changes.push(`width: ${row.width ?? "none"} → ${meta.width}`);
  if (row.height !== meta.height) changes.push(`height: ${row.height ?? "none"} → ${meta.height}`);
  if (row.content_hash && row.content_hash !== content_hash) {
    issues.push({ code: "hash_changed", detail: "The stored bytes differ from the hash on record; recording them resets any review." });
  }
  if (row.width != null && row.height != null && (row.width !== meta.width || row.height !== meta.height)) {
    issues.push({ code: "dimensions_differ", detail: `Recorded ${row.width}×${row.height}, measured ${meta.width}×${meta.height}.` });
  }
  if (row.size_bytes != null && row.size_bytes !== meta.bytes) {
    issues.push({ code: "size_differs", detail: `Recorded ${row.size_bytes} bytes, stored file has ${meta.bytes}.` });
  }
  if (row.mime_type && row.mime_type !== meta.content_type) {
    issues.push({ code: "type_differs", detail: `Recorded ${row.mime_type}, the bytes are ${meta.content_type}.` });
  }
  if (meta.orientation !== 1) {
    issues.push({ code: "rotated", detail: `EXIF orientation ${meta.orientation}: displayed ${meta.width}×${meta.height} (stored ${meta.raw_width}×${meta.raw_height}).` });
  }
  const action = changes.length ? "record" : "unchanged";
  return {
    ...base, stored: "present", measured, action, changes, issues,
    review_reset: action === "record" && row.creative_use !== "unreviewed",
  };
}

export function summarize(entries: Entry[]) {
  const count = (f: (e: Entry) => boolean) => entries.filter(f).length;
  return {
    assets: entries.length,
    stored: count((e) => e.stored === "present"),
    link_only: count((e) => e.issues.some((i) => i.code === "link_only")),
    missing: count((e) => e.stored === "missing"),
    unreadable: count((e) => e.stored === "unreadable" || e.stored === "too_large"),
    unsupported: count((e) => e.issues.some((i) => i.code === "unsupported_type")),
    would_record: count((e) => e.action === "record"),
    unchanged: count((e) => e.action === "unchanged"),
    would_reset_review: count((e) => e.review_reset),
  };
}
