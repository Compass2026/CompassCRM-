// What a reviewer sees of a post's media (Media section, post list).
//
// Brand assets live in the private brand-assets bucket. Pages sign their
// storage paths with the signed-in teammate's own session (storage RLS
// applies; nothing is made public, no credential is involved) and hand the
// result to mediaPreview, which decides what to show: the saved file the post
// carries, a plain error when it cannot be shown, never a substitute image.

export type MediaSource = {
  storage_path: string | null;
  url: string | null;
};

export type MediaPreview =
  | { kind: "image"; src: string; origin: "storage" | "link" }
  | { kind: "error"; message: string };

/**
 * The file a post carries: the stored copy when there is one (that is the file
 * the post is published with), else the asset's own https link.
 * `signed` maps storage paths to signed URLs; `signError` is the signing call's
 * error, if the whole call failed.
 */
export function mediaPreview(asset: MediaSource, signed: ReadonlyMap<string, string>, signError?: string | null): MediaPreview {
  if (asset.storage_path) {
    const src = signed.get(asset.storage_path);
    if (src) return { kind: "image", src, origin: "storage" };
    return {
      kind: "error",
      message: signError
        ? `The image could not be loaded from storage (${signError}). Reload the page; if it persists, check the file in Brand → Assets.`
        : "The stored image could not be found. Check the file in Brand → Assets before approving.",
    };
  }
  if (asset.url && /^https:\/\//i.test(asset.url)) return { kind: "image", src: asset.url, origin: "link" };
  return { kind: "error", message: "This asset has no stored file or link to show. Check it in Brand → Assets before approving." };
}

/**
 * The Graphic section's line when no rendered graphic is linked: say whether
 * the post still carries its own photo(s), so "no graphic" never reads as "no
 * image".
 */
export function noGraphicLine(policy: string, attachedImages: number): string {
  if (attachedImages > 0) {
    return attachedImages === 1
      ? "No rendered graphic: the post uses the attached photo (see Media)."
      : `No rendered graphic: the post uses the ${attachedImages} attached photos (see Media).`;
  }
  return policy === "none" ? "This post goes out without a rendered graphic or photo." : "No graphic is linked yet.";
}

// ── Picking a brand asset for a post ────────────────────────────────────────
// The picker and linkAssetAction share one rule. A Business Profile post
// takes one stored photo approved for creative use, with its file's hash on
// record (the hash the publisher sends against). Other channels keep their
// rule, minus anything a teammate excluded from creative use. Own work and
// approved illustration are both allowed; the picker says which is which.

export type PickableAsset = {
  id: string;
  label: string | null;
  kind: string;
  storage_path: string | null;
  width: number | null;
  height: number | null;
  content_hash: string | null;
  creative_use: string;
  depicts_own_work: boolean | null;
  subjects: string[] | null;
};

export function assetEligibility(platform: string, a: Pick<PickableAsset, "kind" | "storage_path" | "content_hash" | "creative_use">): { ok: true } | { ok: false; reason: string } {
  if (a.creative_use === "excluded") return { ok: false, reason: "This asset is excluded from creative use." };
  if (platform !== "google_business") return { ok: true };
  if (a.kind !== "photo") return { ok: false, reason: "A Business Profile post takes a photo." };
  if (a.creative_use !== "approved") return { ok: false, reason: "Approve the photo for creative use on the Brand tab first." };
  if (!a.storage_path || !/^[0-9a-f]{64}$/.test(a.content_hash ?? "")) {
    return { ok: false, reason: "The photo has no stored, hashed file; it cannot be sent to Google." };
  }
  return { ok: true };
}

/** What the picker shows for an asset: a name a person can tell apart, and the facts that pin it. */
export function pickerText(a: PickableAsset): { title: string; meta: string; alt: string } {
  const subjects = (a.subjects ?? []).filter(Boolean).slice(0, 4);
  const generic = !a.label || /^photo from the /i.test(a.label.trim());
  const title = generic && subjects.length ? subjects.join(", ") : a.label?.trim() || a.kind.replace(/_/g, " ");
  const facts = [
    a.width && a.height ? `${a.width}×${a.height}` : null,
    a.kind === "photo" ? (a.depicts_own_work === true ? "own work" : a.depicts_own_work === false ? "not own work (illustration or stock)" : null) : a.kind.replace(/_/g, " "),
    `id ${a.id.slice(0, 8)}`,
    a.content_hash ? `hash ${a.content_hash.slice(0, 12)}` : "no hash",
  ].filter((x): x is string => !!x);
  return { title, meta: facts.join(" · "), alt: [title, generic && a.label ? a.label : null].filter(Boolean).join(" — ") };
}
