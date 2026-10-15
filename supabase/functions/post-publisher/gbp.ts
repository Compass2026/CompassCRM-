// Business Profile through Zernio: the publisher's pure rules (Oct 11 2026;
// docs/zernio-publisher.md). No Deno, no network; the handler and the app
// both import it.
//
// Compass platform `google_business` is Zernio platform `googlebusiness`.
// Everything is built from the post's approved snapshot (0045) and the
// client's explicit location binding (social_accounts.publish_*), never from
// the live row and never from a search of Zernio. The request pins the exact
// location (platformSpecificData.locationId), so Zernio never falls back to
// an account's default location.
//
// Scope: standard posts — the approved text, at most one stored, hashed JPEG
// or PNG photo, and a button whose type and link Zernio can carry as
// approved. Offer and event posts, and a Call button (Zernio's button needs
// a link), are refused explicitly rather than sent without a field.

import { channelProblems, GBP_CTA_TYPES, type Snapshot } from "./channel.ts";
import { mediaOf, ZERNIO_ACCOUNT_RE, type Binding, type FacebookSnapshot } from "./facebook.ts";

export const GBP_ZERNIO_PLATFORM = "googlebusiness" as const;
export const GBP_LOCATION_RE = /^locations\/[0-9]{1,30}$/;
export const GBP_MAX_CHARS = 1500;
export const GBP_IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png" };
export const GBP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const GBP_IMAGE_MIN = { width: 400, height: 300 };
// Buttons Zernio can carry exactly as approved (type + https link).
export const GBP_ZERNIO_CTA = GBP_CTA_TYPES.filter((t) => t !== "CALL");

export type GbpSnapshot = Snapshot & Pick<FacebookSnapshot, "social_account_id" | "creative">;
export type GbpProblem = { code: string; message: string };

// A location id as Zernio lists it (bare digits) or as Google names it.
export function locationResource(id: string | null | undefined): string | null {
  const t = (id ?? "").trim();
  if (/^[0-9]{1,30}$/.test(t)) return `locations/${t}`;
  return GBP_LOCATION_RE.test(t) ? t : null;
}

// What stops the approved content from going to the Business Profile through
// Zernio as it is. Empty = it may.
export function gbpProblems(s: GbpSnapshot): GbpProblem[] {
  const out: GbpProblem[] = channelProblems(s).map((p) => ({ code: p.code, message: p.message }));
  const add = (code: string, message: string) => out.push({ code, message });
  const raw = s.copy ?? "";
  if (raw.trim() && raw.length > GBP_MAX_CHARS && !out.some((p) => p.code === "too_long")) {
    add("too_long", `Business Profile posts are at most ${GBP_MAX_CHARS} characters (this one is ${raw.length} as approved).`);
  }
  if (s.post_type && s.post_type !== "standard") {
    add("post_type", "Offer and event posts are not published through Zernio yet; only standard posts (text, one photo, a button).");
  }
  const cta = s.cta_type?.trim() || null;
  if (cta === "CALL") {
    add("cta_call", "A Call button cannot be sent through Zernio as approved (its button needs a link). Reopen the post, remove the button or pick another, and approve it again.");
  }
  if (!s.social_account_id) {
    add("no_location", "The post names no Business Profile location. Reopen it, select its verified destination and approve it again.");
  }
  const media = mediaOf(s as FacebookSnapshot);
  if (media.length > 1 && !out.some((p) => p.code === "too_many_photos")) add("too_many_photos", "Business Profile posts take one photo; remove the others.");
  for (const m of media.slice(0, 1)) {
    if (!m.storage_path) add("image_unstored", "The photo has no stored file (a link alone is not sent through Zernio).");
    if (!/^[0-9a-f]{64}$/.test(m.content_hash)) add("image_unhashed", "The photo has no recorded hash to check it against.");
  }
  return out;
}

// Why this post may not go to this binding. Empty = it may.
export function gbpBindingProblems(post: { client_id: string; platform: string; social_account_id: string | null }, b: Binding | null): string[] {
  if (!post.social_account_id) return ["The post names no Business Profile location."];
  if (!b) return ["The post's Business Profile location is not in Compass."];
  const out: string[] = [];
  if (b.client_id !== post.client_id) out.push("The Business Profile location belongs to another client.");
  if (b.platform !== "google_business" || post.platform !== "google_business") out.push("Only Business Profile locations take Business Profile posts.");
  if (b.publish_provider !== "zernio" || !b.publish_account_id || !ZERNIO_ACCOUNT_RE.test(b.publish_account_id)) {
    out.push("This Business Profile location has no verified Zernio binding (Settings → Publisher).");
  } else {
    if (!b.publish_page_id || !GBP_LOCATION_RE.test(b.publish_page_id) || b.publish_page_id !== b.external_account_id) {
      out.push("The Zernio binding names a different location.");
    }
    if (!b.publish_enabled) out.push("Publishing to this Business Profile location is switched off (Settings → Publisher).");
    if (b.publish_health?.status === "error") out.push("Zernio reported this account unhealthy at the last check; verify it again.");
  }
  return out;
}

export type GbpCreateBody = {
  content: string;
  platforms: {
    platform: typeof GBP_ZERNIO_PLATFORM;
    accountId: string;
    platformSpecificData: { locationId: string; topicType: "STANDARD"; callToAction?: { type: string; url: string } };
  }[];
  mediaItems?: { type: "image"; url: string }[];
  publishNow: true;
};

// The exact request: the approved copy unchanged, the location pinned, the
// approved button as Zernio names it, the one uploaded photo.
export function buildGbpCreateBody(s: GbpSnapshot, b: Binding, imageUrl: string | null): GbpCreateBody {
  const cta = s.cta_type?.trim() || null;
  const url = s.cta_url?.trim() || null;
  const psd: GbpCreateBody["platforms"][number]["platformSpecificData"] = { locationId: b.publish_page_id!, topicType: "STANDARD" };
  if (cta && url) psd.callToAction = { type: cta, url };
  const body: GbpCreateBody = {
    content: s.copy ?? "",
    platforms: [{ platform: GBP_ZERNIO_PLATFORM, accountId: b.publish_account_id!, platformSpecificData: psd }],
    publishNow: true,
  };
  if (imageUrl) body.mediaItems = [{ type: "image", url: imageUrl }];
  return body;
}

// Width and height from the bytes (PNG IHDR, JPEG SOFn), or null.
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + len;
    }
  }
  return null;
}

// Zernio's Business Profile limits, checked on the approved bytes so nothing
// is converted or compressed on the way: JPEG or PNG, at most 5 MB, at least
// 400 × 300.
export function gbpImageProblem(bytes: Uint8Array, type: string | null): string | null {
  if (!type || !GBP_IMAGE_TYPES[type]) return "The photo is not a JPEG or PNG file (Business Profile through Zernio takes those as approved).";
  if (bytes.length > GBP_IMAGE_MAX_BYTES) return `The photo is ${(bytes.length / 1048576).toFixed(1)} MB; Business Profile photos are at most 5 MB.`;
  const size = imageSize(bytes);
  if (!size) return "Could not read the photo's dimensions.";
  if (size.width < GBP_IMAGE_MIN.width || size.height < GBP_IMAGE_MIN.height) {
    return `The photo is ${size.width} × ${size.height}; Business Profile photos are at least ${GBP_IMAGE_MIN.width} × ${GBP_IMAGE_MIN.height}.`;
  }
  return null;
}

// Which publisher a Business Profile post goes to — exactly one:
// - the approved snapshot names a location: Zernio (refused there if that
//   location is not bound, enabled and healthy; never sent to Google);
// - the client's transport is zernio (chosen when a location was bound, kept
//   after an unbind until a team admin returns it to google): Zernio, refused
//   there until the post is approved naming a bound location; a client
//   switched to Zernio never posts directly;
// - otherwise: the direct Google path (0046), unchanged.
export type GbpRoute = "zernio" | "google";
export function gbpRoute(snapshotAccountId: string | null | undefined, clientOnZernio: boolean): GbpRoute {
  return snapshotAccountId || clientOnZernio ? "zernio" : "google";
}

// The ids Compass keeps for a Business Profile location as Zernio lists it.
export type ZernioLocation = { id: string; name?: string; accountId?: string; accountName?: string; address?: string; category?: string; websiteUrl?: string; storeCode?: string };

// A market label from the provider's verified website path, never an address.
export function gbpLocationLabel(name: string | null, website: string | null): string | null {
  try {
    const path = new URL(website ?? "").pathname;
    const match = /^\/locations\/[a-z-]+\/([a-z-]+)\/?$/i.exec(path);
    if (match) return `${name ?? "Business Profile"} · ${match[1].split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" ")}`;
  } catch { /* Missing or non-location URL: retain the provider's name. */ }
  return name;
}
