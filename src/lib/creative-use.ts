// Creative use review (0054 / 0055): which of a client's brand assets the
// Creative Engine may use. Pure rules shared by the page, the server action
// and the tests. The database enforces the same rules (constraints and the
// brand_assets guard); these give the teammate the reason before they submit.
//
// A decision is a teammate's alone. AI suggestions (creative_suggestions) are
// shown beside the governed values and may prefill subjects or the focal
// point for the teammate to confirm; they never approve, never decide own
// work, and are never read by approval.

export type CreativeUse = "unreviewed" | "approved" | "excluded";
export type Decision = CreativeUse;

export type ReviewAsset = {
  id: string;
  kind: string;
  source: string;
  label: string;
  storage_path: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
  content_hash: string | null;
  content_hashed_at: string | null;
  creative_use: string;
  depicts_own_work: boolean | null;
  subjects: string[];
  focal_x: number | null;
  focal_y: number | null;
  creative_review_note: string | null;
  creative_reviewed_at: string | null;
  creative_suggestions: unknown;
  // Optional context for the reviewer: what source-assets measured, and the
  // asset's own notes. Neither decides anything.
  content_measurement?: unknown;
  notes?: string | null;
};

export const SUBJECT_RE = /^[a-z0-9][a-z0-9 -]{0,39}$/;
export const MAX_SUBJECTS = 20;

export const isPhoto = (a: Pick<ReviewAsset, "kind">) => a.kind === "photo";
export const isLogo = (a: Pick<ReviewAsset, "kind">) => a.kind.startsWith("logo") || a.kind === "wordmark";

export type FileStatus = "hashed" | "unhashed" | "link_only" | "no_file";
export function fileStatus(a: Pick<ReviewAsset, "storage_path" | "url" | "content_hash" | "content_hashed_at">): FileStatus {
  if (!a.storage_path) return a.url ? "link_only" : "no_file";
  return a.content_hash && a.content_hashed_at ? "hashed" : "unhashed";
}
export const fileStatusLabel: Record<FileStatus, string> = {
  hashed: "Hashed from the stored file",
  unhashed: "Stored, not hashed yet",
  link_only: "Link only (no stored file)",
  no_file: "No file",
};

// What stands between this asset and an approval, whatever the teammate enters.
export function fileBlockers(a: ReviewAsset): string[] {
  const out: string[] = [];
  const s = fileStatus(a);
  if (s === "link_only") out.push("Only a link is recorded. Store the file first (brand-scan import), then hash it.");
  if (s === "no_file") out.push("No stored file.");
  if (s === "unhashed") out.push("The stored file has not been hashed yet (source-assets).");
  if (s === "hashed" && !(a.width && a.height)) out.push("The file's dimensions are unknown.");
  return out;
}

export function parseSubjects(raw: string): { subjects: string[]; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim().toLowerCase().replace(/\s+/g, " ");
    if (!s) continue;
    if (!SUBJECT_RE.test(s)) { errors.push(`"${part.trim()}" is not a subject tag (letters, digits, spaces or hyphens; up to 40).`); continue; }
    if (!seen.has(s)) { seen.add(s); subjects.push(s); }
  }
  if (subjects.length > MAX_SUBJECTS) errors.push(`At most ${MAX_SUBJECTS} subject tags.`);
  return { subjects, errors };
}

// Focal point as entered (percent, 0–100) → stored fractions (0–1).
export function parseFocal(xRaw: string, yRaw: string): { x: number | null; y: number | null; error: string | null } {
  if (!xRaw.trim() && !yRaw.trim()) return { x: null, y: null, error: null };
  if (!xRaw.trim() || !yRaw.trim()) return { x: null, y: null, error: "The focal point needs both x and y." };
  const x = Number(xRaw), y = Number(yRaw);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    return { x: null, y: null, error: "The focal point is two percentages between 0 and 100." };
  }
  return { x: Math.round(x * 10) / 1000, y: Math.round(y * 10) / 1000, error: null };
}

export type ReviewInput = {
  decision: string;
  ownWork: string;   // "yes" | "no" | "" (undecided)
  subjects: string;
  focalX: string;
  focalY: string;
  reason: string;
};

export type ReviewPatch = {
  creative_use: CreativeUse;
  depicts_own_work: boolean | null;
  subjects: string[];
  focal_x: number | null;
  focal_y: number | null;
  creative_review_note: string | null;
};

// Where the file came from, for the reviewer: the scan or import, the host
// and the original file name (the stored copy is what is reviewed; the
// original address may no longer answer).
const SOURCE_LABELS: Record<string, string> = {
  website_scan: "Website scan", link: "Imported from a link", upload: "Uploaded",
};
export function sourceDetails(a: Pick<ReviewAsset, "source" | "url">): { label: string; host: string | null; fileName: string | null } {
  const label = SOURCE_LABELS[a.source] ?? a.source;
  if (!a.url) return { label, host: null, fileName: null };
  try {
    const u = new URL(a.url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? null;
    return { label, host: u.hostname.replace(/^www\./, ""), fileName: last ? decodeURIComponent(last) : null };
  } catch {
    return { label, host: null, fileName: null };
  }
}

// Quality warnings: facts about the stored file a reviewer should weigh.
// They never block a decision and never decide one; the Creative Engine's
// own quality gate (docs/canva-integration.md) applies at render time.
export const HERO_MIN_SHORT_SIDE = 1080;
export const LOW_BYTES_PER_PIXEL = 0.06;
export type QualityWarning = { code: "below_hero" | "heavily_compressed" | "resized_from_smaller" | "facebook_download" | "messaging_app" | "raster_logo"; text: string };

function measuredBytes(m: unknown): number | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const b = (m as Record<string, unknown>).bytes;
  return typeof b === "number" && b > 0 ? b : null;
}
function measuredType(m: unknown): string | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const t = (m as Record<string, unknown>).content_type;
  return typeof t === "string" ? t : null;
}

export function qualityWarnings(a: Pick<ReviewAsset, "kind" | "url" | "width" | "height" | "content_measurement">): QualityWarning[] {
  const out: QualityWarning[] = [];
  const { fileName } = sourceDetails({ source: "", url: a.url });
  const w = a.width ?? 0, h = a.height ?? 0;
  if (isPhoto(a)) {
    const short = Math.min(w, h);
    if (w && h && short < HERO_MIN_SHORT_SIDE) {
      out.push({ code: "below_hero", text: `Below hero size: the short side is ${short} px (a hero photo needs ${HERO_MIN_SHORT_SIDE} px). Usable as a grid or mosaic cell only.` });
    }
    const bytes = measuredBytes(a.content_measurement);
    if (bytes && w && h && bytes / (w * h) < LOW_BYTES_PER_PIXEL) {
      out.push({ code: "heavily_compressed", text: `Heavily compressed (${Math.round(bytes / 1024)} KB for ${w}×${h}). Check for blocking or smearing at full size.` });
    }
    const named = fileName?.match(/-(\d{2,5})x(\d{2,5})(?:-\d+)?\.[a-z0-9]+$/i);
    if (named && w && h) {
      const [nw, nh] = [Number(named[1]), Number(named[2])];
      if (w > nw || h > nh || (nw > nh) !== (w > h)) {
        out.push({ code: "resized_from_smaller", text: `The original file name says ${nw}×${nh}, but the stored file is ${w}×${h}: it was probably re-cropped or enlarged. Check sharpness at full size.` });
      }
    }
    if (fileName && /^\d{6,}_\d{6,}_\d+_[a-z]\b/i.test(fileName)) {
      out.push({ code: "facebook_download", text: "The file name is a Facebook download. Confirm it is the client's own job, not a shared or customer post, before answering own work." });
    }
    if (fileName && /whatsapp/i.test(fileName)) {
      out.push({ code: "messaging_app", text: "Sent through WhatsApp, which recompresses photos. Check detail at full size." });
    }
  } else if (isLogo(a)) {
    const type = measuredType(a.content_measurement);
    if (type && type !== "image/svg+xml") {
      out.push({ code: "raster_logo", text: `Raster logo (${type.replace("image/", "").toUpperCase()}${w && h ? `, ${w}×${h}` : ""}): fine at logo-tile size, not a vector master.` });
    }
  }
  return out;
}

// The governed values a decision writes, or why it cannot be made.
export function validateReview(a: ReviewAsset, input: ReviewInput): { ok: true; patch: ReviewPatch } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const decision = input.decision as Decision;
  if (!["approved", "excluded", "unreviewed"].includes(decision)) return { ok: false, errors: ["Choose Approve, Exclude or Unreviewed."] };
  const { subjects, errors: subjectErrors } = parseSubjects(input.subjects);
  errors.push(...subjectErrors);
  const focal = parseFocal(input.focalX, input.focalY);
  if (focal.error) errors.push(focal.error);
  const ownWork = input.ownWork === "yes" ? true : input.ownWork === "no" ? false : null;
  const reason = input.reason.trim();

  if (decision === "approved") {
    errors.push(...fileBlockers(a));
    if (subjects.length === 0) errors.push("Add at least one subject tag.");
    if (isPhoto(a)) {
      if (ownWork === null) errors.push("Decide whether the photo shows the client's own work.");
      if (focal.x === null) errors.push("Set the focal point for a photo.");
    }
  }
  if (decision === "excluded" && !reason) errors.push("Say why the image is excluded.");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    patch: {
      creative_use: decision,
      depicts_own_work: ownWork,
      subjects,
      focal_x: focal.x,
      focal_y: focal.y,
      creative_review_note: reason || null,
    },
  };
}

// Stale-page guard: the decision applies to the file and state the teammate saw.
export type ReviewSnapshot = { content_hash: string | null; creative_use: string; creative_reviewed_at: string | null };
export const sameReviewSnapshot = (a: ReviewSnapshot, b: ReviewSnapshot) =>
  a.content_hash === b.content_hash && a.creative_use === b.creative_use && a.creative_reviewed_at === b.creative_reviewed_at;

// AI suggestions, displayed apart from governed values. Only well-formed
// fields are shown; anything else is ignored rather than trusted.
export type Suggestions = { subjects: string[]; focal: { x: number; y: number } | null; ownWork: boolean | null; model: string | null };
export function readSuggestions(raw: unknown): Suggestions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const subjects = Array.isArray(r.subjects)
    ? parseSubjects(r.subjects.filter((s) => typeof s === "string").join(",")).subjects : [];
  const f = r.focal as Record<string, unknown> | undefined;
  const focal = f && typeof f.x === "number" && typeof f.y === "number" && f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1
    ? { x: f.x, y: f.y } : null;
  const ownWork = typeof r.depicts_own_work === "boolean" ? r.depicts_own_work : null;
  const model = typeof r.model === "string" ? r.model.slice(0, 60) : null;
  if (!subjects.length && !focal && ownWork === null) return null;
  return { subjects, focal, ownWork, model };
}

export type ReviewCounts = Record<CreativeUse, number> & { hashed: number; total: number; linkOnly: number };
export function reviewCounts(assets: ReviewAsset[]): ReviewCounts {
  const c: ReviewCounts = { unreviewed: 0, approved: 0, excluded: 0, hashed: 0, total: assets.length, linkOnly: 0 };
  for (const a of assets) {
    const u = (["approved", "excluded"].includes(a.creative_use) ? a.creative_use : "unreviewed") as CreativeUse;
    c[u]++;
    const s = fileStatus(a);
    if (s === "hashed") c.hashed++;
    if (s === "link_only") c.linkOnly++;
  }
  return c;
}

export const useLabels: Record<CreativeUse, string> = {
  unreviewed: "Unreviewed",
  approved: "Approved for creative",
  excluded: "Excluded",
};

// Governance history lines (creative_governance_events for brand assets).
export function historyLine(e: { action: string; actor_kind: string; note: string | null; changes: unknown }, who: string | null): string {
  const actor = e.actor_kind === "team" ? (who ?? "A teammate") : e.actor_kind === "hasher" ? "Source hashing" : e.actor_kind === "worker" ? "The worker" : e.actor_kind;
  const ch = (e.changes ?? {}) as Record<string, { from?: unknown; to?: unknown } | unknown>;
  const hashTo = (ch.content_hash as { to?: string } | undefined)?.to;
  switch (e.action) {
    case "approved": return `${actor} approved it for creative use${(ch.approved_content_hash as string) ? ` (file ${String(ch.approved_content_hash).slice(0, 12)}…)` : ""}.`;
    case "excluded": return `${actor} excluded it${e.note ? `: ${e.note}` : ""}.`;
    case "unreviewed": return `${actor} set it back to unreviewed.`;
    case "metadata_changed": return `${actor} changed ${Object.keys(ch).filter((k) => k !== "file").join(", ")}.`;
    case "reset_file_changed": return `The file changed; the review was reset (${actor}).`;
    case "hashed": return `${actor} recorded the file's hash${hashTo ? ` ${hashTo.slice(0, 12)}…` : ""}.`;
    case "rehashed": return `${actor} found new bytes; hash now ${hashTo ? `${hashTo.slice(0, 12)}…` : "changed"}.`;
    case "hash_cleared": return `The file fields changed; the hash was cleared (${actor}).`;
    default: return `${actor}: ${e.action}.`;
  }
}
