// A blog draft's hero image (20261015210000): one stored, hashed brand asset
// of the draft's client, kind photo or social_post, with alt text. The
// drafter may propose it on submit (draft.hero_asset_id + draft.hero_alt);
// a teammate may choose or replace it on the draft page. Either way the
// database re-checks it (content_drafts_hero_guard), a change bumps the
// version, and approval pins the asset id, its content hash and the alt text.
//
// A social_post asset is a generated graphic: illustrative, never evidence of
// the client's work, never a claim or a source.
export type DraftHero = { asset_id: string; alt: string };
export type HeroAsset = {
  id: string; client_id: string; kind: string; storage_path: string | null; content_hash: string | null;
  mime_type: string | null; width: number | null; height: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HERO_KINDS = ["photo", "social_post"] as const;
export const HERO_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
export const HERO_ALT_MAX = 250;
export const ILLUSTRATIVE_LABEL = "Illustrative graphic, not a photo of the client's work";

/** The optional hero on a drafter payload: null when absent, a message when malformed. */
export function parseHero(o: Record<string, unknown>): DraftHero | null | string {
  const id = o.hero_asset_id, alt = o.hero_alt;
  if (id == null && alt == null) return null;
  if (typeof id !== "string" || !UUID.test(id)) return "draft.hero_asset_id must be a uuid";
  if (typeof alt !== "string" || !alt.trim()) return "draft.hero_alt is required with a hero image";
  if (alt.trim().length > HERO_ALT_MAX) return `draft.hero_alt is at most ${HERO_ALT_MAX} characters`;
  return { asset_id: id, alt: alt.trim() };
}

/** Why this asset cannot be the draft's hero (empty when it can). */
export function heroProblems(asset: HeroAsset | null, clientId: string): string[] {
  if (!asset || asset.client_id !== clientId) return ["The hero image must be one of this client's brand assets."];
  const out: string[] = [];
  if (!(HERO_KINDS as readonly string[]).includes(asset.kind)) out.push("The hero image must be a photo or a social graphic.");
  if (!asset.storage_path || !asset.content_hash) out.push("The hero image must be a stored, hashed file.");
  if (!asset.mime_type || !(HERO_MIME as readonly string[]).includes(asset.mime_type)) out.push("The hero image must be a PNG, JPEG or WebP file.");
  if (!asset.width || !asset.height) out.push("The hero image needs recorded dimensions.");
  return out;
}

export const isIllustrative = (kind: string) => kind === "social_post";
