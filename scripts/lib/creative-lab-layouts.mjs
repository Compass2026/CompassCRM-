// Creative Lab layouts (Preview Mode, Oct 8 2026; docs/creative-lab.md).
//
// Photo-first treatments for the lab, alongside the five registered
// families: the client's own photo carries the post and the design is a light
// signature (the logo tile, at most a label and one governed line). Built on
// the Creative Engine's spec types, palette, fonts and logo (kits.ts), and
// rendered by the same render() — so the same governance applies: every word
// is a governed role, every photo an approved own-work file that is never
// enlarged. They are not registered templates; a lab layout chosen for
// publishing becomes a registered template version first (0054).
import { KITS } from "../../supabase/functions/creative-engine/kits.ts";
import { lucasTemplates } from "../../supabase/functions/creative-engine/registry.ts";
import { SPEC_SCHEMA } from "../../supabase/functions/creative-engine/spec.ts";

export const LAB_LABELS = [
  { id: "our_work", text: "Our work", requires: "all_photos_own_work" },
  { id: "spring", text: "Spring" }, { id: "summer", text: "Summer" }, { id: "fall", text: "Fall" },
  { id: "winter", text: "Winter" }, { id: "storm_season", text: "Storm season" },
  // Neutral design text for photo-first posts: invitations, never facts.
  { id: "look_closer", text: "Look closer" }, { id: "on_the_job", text: "On the job", requires: "all_photos_own_work" },
];

const logo = (x, y, w, h) => ({ type: "logo", x, y, w, h, fill: "charcoal", keyline: { color: "blue", width: 2 }, radius: 12, pad: Math.round(h / 10) });
const eyebrow = (w, size) => ({
  type: "text", slot: "eyebrow", roles: ["template_label", "service_segment"], required: false,
  style: { font: "montserrat-700", size, line_height: Math.round(size * 1.35), color: "sky", tracking: 3, transform: "uppercase" },
  max_lines: 1, max_words: 5, w, background: "charcoal",
});
const line = (w, size, lines) => ({
  type: "text", slot: "headline", roles: ["service_name", "claim"], required: false,
  style: { font: "montserrat-800", size, line_height: Math.round(size * 1.18), color: "text", tracking: 0.3 },
  max_lines: lines, max_words: 8, w, background: "charcoal",
});
const website = (w, size) => ({
  type: "text", slot: "website", roles: ["website"], required: true, auto: "website",
  style: { font: "poppins-500", size, line_height: Math.round(size * 1.35), color: "muted" },
  max_lines: 1, max_words: 1, w, background: "charcoal",
});

function spec(kit, family, channel, w, h, groups, elements) {
  return {
    schema: SPEC_SCHEMA, family, mode: "lab", channel,
    canvas: { width: w, height: h, background: "charcoal" },
    safe_area: channel === "google_business" ? { x: 150, y: 0, w: 900, h: 900 } : { x: 72, y: 0, w: 936, h: 1350 },
    palette: kit.palette, fonts: kit.fonts, photo_groups: groups, labels: LAB_LABELS,
    blocked_phrases: kit.blocked_phrases, logo_asset_id: kit.logo_asset_id, elements,
  };
}

// Facebook / Instagram 4:5. The photo, framed; a slim signature under it.
function fieldPhoto(kit, channel) {
  return spec(kit, "real_work", channel, 1080, 1350, [{ slot: "photos", min: 1, max: 1, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 72, y: 72, w: 936, h: 1040, radius: 18 },
    logo(72, 1150, 168, 116),
    { type: "stack", x: 272, y: 1132, w: 736, max_bottom: 1318, gap: 8, anchor: "center",
      items: [eyebrow(736, 22), line(736, 36, 2), website(736, 24)] },
  ]);
}

// Business Profile 4:3. One photo, nothing on it but the logo tile (hero-grade
// photos only: the canvas is 1200 px wide and nothing is enlarged).
function gbpPhoto(kit) {
  return spec(kit, "real_work", "google_business", 1200, 900, [{ slot: "photos", min: 1, max: 1, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "hero", x: 0, y: 0, w: 1200, h: 900 },
    logo(170, 776, 140, 96),
  ]);
}

// Business Profile 4:3. Two of the client's photos side by side; the logo tile.
function gbpPair(kit) {
  return spec(kit, "real_work", "google_business", 1200, 900, [{ slot: "photos", min: 2, max: 2, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 0, y: 0, w: 596, h: 900 },
    { type: "photo", slot: "photos", index: 1, role: "cell", x: 604, y: 0, w: 596, h: 900 },
    logo(170, 776, 140, 96),
  ]);
}

// Business Profile 4:3. One photo and a quiet caption panel.
function gbpField(kit) {
  return spec(kit, "real_work", "google_business", 1200, 900, [{ slot: "photos", min: 1, max: 1, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 0, y: 0, w: 640, h: 900 },
    { type: "rect", x: 640, y: 0, w: 4, h: 900, fill: "blue" },
    logo(692, 96, 168, 116),
    { type: "stack", x: 692, y: 260, w: 358, max_bottom: 820, gap: 14, anchor: "center",
      items: [eyebrow(358, 20), line(358, 38, 4), website(358, 22)] },
  ]);
}

// Plain: the photo and nothing else, the way a contractor posts from the
// job. Sized so 950 px sources are never enlarged.
function plain(kit, channel, w, h) {
  return spec(kit, "real_work", channel, w, h, [{ slot: "photos", min: 1, max: 1, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 0, y: 0, w, h },
  ]);
}

// The photo with one small label in the corner.
function pillPhoto(kit, channel, w, h) {
  return spec(kit, "real_work", channel, w, h, [{ slot: "photos", min: 1, max: 1, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 0, y: 0, w, h },
    { type: "pill", slot: "label", roles: ["template_label"], required: true, x: 32, y: 32,
      style: { font: "montserrat-800", size: 26, line_height: 32, color: "sky", tracking: 2, transform: "uppercase" },
      fill: "charcoal", pad_x: 24, pad_y: 14, max_words: 4, max_w: 600, background: "charcoal" },
  ]);
}

// Facebook 4:5: two job photos side by side at full height; slim signature.
// (Portrait sources keep their whole frame: wide strips crop them to sky.)
function diptych(kit, channel) {
  return spec(kit, "real_work", channel, 1080, 1350, [{ slot: "photos", min: 2, max: 2, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 72, y: 72, w: 462, h: 990, radius: 14 },
    { type: "photo", slot: "photos", index: 1, role: "cell", x: 546, y: 72, w: 462, h: 990, radius: 14 },
    logo(72, 1132, 168, 116),
    { type: "stack", x: 272, y: 1100, w: 736, max_bottom: 1300, gap: 8, anchor: "center",
      items: [eyebrow(736, 22), line(736, 36, 2), website(736, 24)] },
  ]);
}

// Business Profile 4:3: two photos side by side, nothing else.
function plainPair(kit) {
  return spec(kit, "real_work", "google_business", 1200, 900, [{ slot: "photos", min: 2, max: 2, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 0, y: 0, w: 596, h: 900 },
    { type: "photo", slot: "photos", index: 1, role: "cell", x: 604, y: 0, w: 596, h: 900 },
  ]);
}

// Facebook 4:5: three job photos stacked as a story strip; slim signature.
function strip(kit, channel) {
  return spec(kit, "real_work", channel, 1080, 1350, [{ slot: "photos", min: 3, max: 3, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 72, y: 60, w: 936, h: 330, radius: 14 },
    { type: "photo", slot: "photos", index: 1, role: "cell", x: 72, y: 402, w: 936, h: 330, radius: 14 },
    { type: "photo", slot: "photos", index: 2, role: "cell", x: 72, y: 744, w: 936, h: 330, radius: 14 },
    logo(72, 1132, 168, 116),
    { type: "stack", x: 272, y: 1112, w: 736, max_bottom: 1300, gap: 8, anchor: "center",
      items: [eyebrow(736, 22), line(736, 36, 2), website(736, 24)] },
  ]);
}

// The credentials / checklist card (the 6H direction) without the phone,
// website and CTA button the registered family bakes in: a photo, the
// business name, one governed headline, checked governed points and a small
// logo. For information that genuinely benefits from design.
const cardHeadline = (w, size, lines) => ({
  type: "text", slot: "headline", roles: ["claim"], required: true,
  style: { font: "montserrat-800", size, line_height: Math.round(size * 1.08), color: "text", tracking: 0.5, transform: "uppercase" },
  max_lines: lines, max_words: 6, w, background: "charcoal",
});
const cardPoints = (w, gbp) => ({
  type: "list", slot: "points", roles: ["claim"], required: true, min_items: 1, max_items: 3,
  max_words_each: 8, max_lines_each: 2,
  style: { font: "poppins-500", size: gbp ? 21 : 28, line_height: gbp ? 29 : 38, color: "text" },
  icon: { size: gbp ? 26 : 32, color: "sky", gap: gbp ? 14 : 18 }, item_gap: gbp ? 12 : 16, w, background: "charcoal",
});
const cardEyebrow = (w, size) => ({ ...eyebrow(w, size), roles: ["business_name", "service_segment"] });
function cardFacebook(kit, channel) {
  return spec(kit, "trust_know_how", channel, 1080, 1350, [{ slot: "photos", min: 1, max: 1, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "feature", x: 0, y: 0, w: 1080, h: 620 },
    { type: "rect", x: 0, y: 620, w: 1080, h: 6, fill: "blue" },
    { type: "stack", x: 72, y: 676, w: 936, max_bottom: 1180, gap: 24, anchor: "center",
      items: [cardEyebrow(936, 24), cardHeadline(936, 62, 2), cardPoints(936, false)] },
    logo(72, 1214, 140, 96),
  ]);
}
function cardGbp(kit) {
  return spec(kit, "trust_know_how", "google_business", 1200, 900, [{ slot: "photos", min: 1, max: 1, require_service_match: false }], [
    { type: "photo", slot: "photos", index: 0, role: "feature", x: 0, y: 0, w: 560, h: 900 },
    { type: "rect", x: 560, y: 0, w: 4, h: 900, fill: "blue" },
    { type: "stack", x: 612, y: 72, w: 438, max_bottom: 760, gap: 22, anchor: "center",
      items: [cardEyebrow(438, 20), cardHeadline(438, 42, 4), cardPoints(438, true)] },
    logo(612, 784, 120, 84),
  ]);
}

const LAB = {
  "card-facebook": (k) => cardFacebook(k, "facebook"),
  "card-gbp": cardGbp,
  "plain-portrait-facebook": (k) => plain(k, "facebook", 944, 1180),
  "plain-landscape-gbp": (k) => plain(k, "google_business", 944, 708),
  "pill-portrait-facebook": (k) => pillPhoto(k, "facebook", 944, 1180),
  "pill-landscape-gbp": (k) => pillPhoto(k, "google_business", 944, 708),
  "strip-facebook": (k) => strip(k, "facebook"),
  "diptych-facebook": (k) => diptych(k, "facebook"),
  "plain-pair-gbp": plainPair,
  "field-photo-facebook": (k) => fieldPhoto(k, "facebook"),
  "field-photo-instagram": (k) => fieldPhoto(k, "instagram"),
  "photo-gbp": gbpPhoto,
  "pair-gbp": gbpPair,
  "field-gbp": gbpField,
};

// A lab layout ("lab-field-photo-facebook") or a registered family
// ("lucas-trust-know-how-gbp") for a client kit.
export function labTemplate(key, kitSlug = "lucas") {
  const kit = KITS[kitSlug];
  if (key.startsWith("lab-")) {
    const make = LAB[key.slice(4)];
    if (!make) return null;
    const s = make(kit);
    return { key, version: 1, channel: s.channel, name: `Lab ${key.slice(4)}`, description: "Creative Lab layout (preview only)",
      output_width: s.canvas.width, output_height: s.canvas.height, mime_type: "image/png", spec: s };
  }
  return lucasTemplates().find((t) => t.key === key) ?? null;
}

export const LAB_LAYOUTS = Object.keys(LAB).map((k) => `lab-${k}`);
