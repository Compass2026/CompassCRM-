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
