// Fixed design structure for the five cleared families, on the two channel
// canvases. Geometry, typography roles, spacing, palette tokens, footer, logo
// and CTA placement live here; every word comes through a slot (govern.ts).
//
// Canvases (checked against the platforms' published guidance, Sept 2026):
//   google_business  1200×900 (4:3), PNG ≤ 5 MB; text, logo and CTA inside
//                    the central 900×900 so square crops keep them.
//   facebook / instagram  1080×1350 (4:5), the tallest ratio the Instagram
//                    API accepts; content ≥ 72 px from the sides so the 3:4
//                    profile grid (≈34 px trimmed each side) keeps it.
import type { Channel, Element, Family, ListSlot, PillSlot, Stack, TemplateSpec, TextSlot, Label, PhotoGroup } from "./spec.ts";
import type { BrandKit } from "./kits.ts";
import { SPEC_SCHEMA } from "./spec.ts";

type Geo = { W: number; H: number; footerY: number; left: number; right: number };
const GBP: Geo = { W: 1200, H: 900, footerY: 780, left: 150, right: 1050 };
const SOCIAL: Geo = { W: 1080, H: 1350, footerY: 1206, left: 72, right: 1008 };
const geo = (c: Channel) => (c === "google_business" ? GBP : SOCIAL);

// ── Shared components ─────────────────────────────────────────────────────────
function footer(c: Channel): Element[] {
  const g = geo(c);
  const gbp = c === "google_business";
  const bandH = g.H - g.footerY;
  const tileH = gbp ? 96 : 116, tileW = gbp ? 140 : 168;
  const boxW = gbp ? 420 : 520;
  const bx = g.right - boxW;
  const phoneSize = gbp ? 30 : 36, webSize = gbp ? 22 : 26;
  const phoneLh = Math.round(phoneSize * 1.25), webLh = Math.round(webSize * 1.35);
  const top = g.footerY + Math.round((bandH - phoneLh - webLh - 4) / 2);
  return [
    { type: "rect", x: 0, y: g.footerY, w: g.W, h: bandH, fill: "panel" },
    { type: "rect", x: 0, y: g.footerY, w: g.W, h: gbp ? 4 : 5, fill: "blue" },
    { type: "logo", x: g.left, y: g.footerY + Math.round((bandH - tileH) / 2) + 2, w: tileW, h: tileH,
      fill: "charcoal", keyline: { color: "blue", width: 2 }, radius: 12, pad: gbp ? 10 : 12 },
    { type: "text", slot: "phone", x: bx, y: top, w: boxW, roles: ["phone"], required: true, auto: "phone",
      style: { font: "montserrat-800", size: phoneSize, line_height: phoneLh, color: "sky", tracking: 0.5, align: "right" },
      max_lines: 1, max_words: 3, background: "panel" },
    { type: "text", slot: "website", x: bx, y: top + phoneLh + 4, w: boxW, roles: ["website"], required: true, auto: "website",
      style: { font: "poppins-500", size: webSize, line_height: webLh, color: "muted", align: "right" },
      max_lines: 1, max_words: 1, background: "panel" },
  ] as Element[];
}

type Tone = { ground: "charcoal" | "text"; head: "text" | "charcoal"; sub: "muted" | "panel"; eyebrow: "sky" | "blue";
  pillFill: "sky" | "charcoal"; pillText: "charcoal" | "sky" };
const DARK: Tone = { ground: "charcoal", head: "text", sub: "muted", eyebrow: "sky", pillFill: "sky", pillText: "charcoal" };
const LIGHT: Tone = { ground: "text", head: "charcoal", sub: "panel", eyebrow: "blue", pillFill: "charcoal", pillText: "sky" };

const eyebrow = (c: Channel, roles: TextSlot["roles"], required: boolean, tone: Tone, w: number): TextSlot => ({
  type: "text", slot: "eyebrow", roles, required,
  style: { font: "montserrat-700", size: c === "google_business" ? 20 : 24, line_height: c === "google_business" ? 28 : 32,
    color: tone.eyebrow, tracking: 3, transform: "uppercase" },
  max_lines: 1, max_words: 5, w, background: tone.ground,
});
const headline = (roles: TextSlot["roles"], size: number, maxLines: number, tone: Tone, w: number): TextSlot => ({
  type: "text", slot: "headline", roles, required: true,
  style: { font: "montserrat-800", size, line_height: Math.round(size * 1.08), color: tone.head, tracking: 0.5, transform: "uppercase" },
  max_lines: maxLines, max_words: 6, w, background: tone.ground,
});
const subline = (roles: TextSlot["roles"], size: number, maxLines: number, tone: Tone, w: number): TextSlot => ({
  type: "text", slot: "subline", roles, required: false,
  style: { font: "poppins-500", size, line_height: Math.round(size * 1.4), color: tone.sub },
  max_lines: maxLines, max_words: 12, w, background: tone.ground,
});
const cta = (c: Channel, tone: Tone, maxW: number, align?: "left" | "right"): PillSlot => ({
  type: "pill", slot: "cta", roles: ["standing_cta"], required: true, auto: "standing_cta",
  style: { font: "montserrat-800", size: c === "google_business" ? 22 : 26, line_height: c === "google_business" ? 28 : 32,
    color: tone.pillText, tracking: 1, transform: "uppercase" },
  fill: tone.pillFill, pad_x: c === "google_business" ? 26 : 32, pad_y: c === "google_business" ? 14 : 16,
  max_words: 5, max_w: maxW, background: tone.ground, ...(align ? { align } : {}),
});
const points = (c: Channel, min: number, max: number, tone: Tone, w: number): ListSlot => ({
  type: "list", slot: "points", roles: ["claim"], required: min > 0, min_items: min, max_items: max,
  max_words_each: 8, max_lines_each: 2,
  style: { font: "poppins-500", size: c === "google_business" ? 21 : 28, line_height: c === "google_business" ? 29 : 38, color: tone.head },
  icon: { size: c === "google_business" ? 26 : 32, color: tone.eyebrow === "blue" ? "blue" : "sky", gap: c === "google_business" ? 14 : 18 },
  item_gap: c === "google_business" ? 12 : 16, w, background: tone.ground,
});
const stack = (x: number, y: number, w: number, maxBottom: number, gap: number, items: (TextSlot | PillSlot | ListSlot)[],
  anchor: Stack["anchor"] = "top"): Stack => ({ type: "stack", x, y, w, max_bottom: maxBottom, gap, anchor, items });

// ── The families ──────────────────────────────────────────────────────────────
type Built = { mode?: string; elements: Element[]; groups: PhotoGroup[]; labels: Label[]; ground: Tone["ground"] };

function serviceSpotlight(c: Channel): Built {
  const svc = ["service_name", "claim"] as TextSlot["roles"];
  if (c === "google_business") {
    return { ground: "charcoal", labels: [], groups: [{ slot: "photos", min: 1, max: 1, require_service_match: true }], elements: [
      { type: "photo", slot: "photos", index: 0, role: "hero", x: 640, y: 0, w: 560, h: 780 },
      { type: "rect", x: 636, y: 0, w: 4, h: 780, fill: "blue" },
      stack(150, 88, 460, 752, 22, [eyebrow(c, ["service_segment", "business_name"], false, DARK, 460),
        headline(svc, 52, 3, DARK, 460), subline(["claim", "tagline"], 24, 3, DARK, 440),
        points(c, 0, 3, DARK, 460), cta(c, DARK, 460)], "center"),
      ...footer(c),
    ] };
  }
  return { ground: "charcoal", labels: [], groups: [{ slot: "photos", min: 1, max: 1, require_service_match: true }], elements: [
    { type: "photo", slot: "photos", index: 0, role: "hero", x: 0, y: 0, w: 1080, h: 790 },
    { type: "rect", x: 0, y: 790, w: 1080, h: 6, fill: "blue" },
    stack(72, 826, 936, 1170, 20, [eyebrow(c, ["service_segment", "business_name"], false, DARK, 936),
      headline(svc, 80, 2, DARK, 936), subline(["claim", "tagline"], 30, 2, DARK, 900), cta(c, DARK, 936)], "center"),
    ...footer(c),
  ] };
}

function trustKnowHow(c: Channel): Built {
  // Authority mode: a sourced credential as the headline, up to three more as
  // checked points. (Educational mode waits for approved educational copy.)
  if (c === "google_business") {
    return { mode: "authority", ground: "charcoal", labels: [], groups: [{ slot: "photos", min: 1, max: 1, require_service_match: false }], elements: [
      { type: "photo", slot: "photos", index: 0, role: "feature", x: 0, y: 0, w: 560, h: 780 },
      { type: "rect", x: 560, y: 0, w: 4, h: 780, fill: "blue" },
      stack(612, 88, 438, 752, 22, [eyebrow(c, ["business_name", "service_segment"], false, DARK, 438),
        headline(["claim"], 42, 4, DARK, 438), points(c, 2, 3, DARK, 438), cta(c, DARK, 438)], "center"),
      ...footer(c),
    ] };
  }
  return { mode: "authority", ground: "charcoal", labels: [], groups: [{ slot: "photos", min: 1, max: 1, require_service_match: false }], elements: [
    { type: "photo", slot: "photos", index: 0, role: "feature", x: 0, y: 0, w: 1080, h: 600 },
    { type: "rect", x: 0, y: 600, w: 1080, h: 6, fill: "blue" },
    stack(72, 650, 936, 1174, 22, [eyebrow(c, ["business_name", "service_segment"], false, DARK, 936),
      headline(["claim"], 62, 2, DARK, 936), points(c, 2, 3, DARK, 936), cta(c, DARK, 936)], "center"),
    ...footer(c),
  ] };
}

const SEASONS: Label[] = [
  { id: "spring", text: "Spring" }, { id: "summer", text: "Summer" }, { id: "fall", text: "Fall" },
  { id: "winter", text: "Winter" }, { id: "storm_season", text: "Storm season" },
];

function seasonal(c: Channel): Built {
  // Non-offer mode only: a season label, the service and a governed line.
  if (c === "google_business") {
    return { mode: "seasonal", ground: "charcoal", labels: SEASONS, groups: [{ slot: "photos", min: 2, max: 2, require_service_match: true }], elements: [
      { type: "photo", slot: "photos", index: 0, role: "cell", x: 640, y: 0, w: 560, h: 388 },
      { type: "photo", slot: "photos", index: 1, role: "cell", x: 640, y: 392, w: 560, h: 388 },
      { type: "rect", x: 636, y: 0, w: 4, h: 780, fill: "blue" },
      stack(150, 96, 460, 752, 22, [eyebrow(c, ["template_label"], true, DARK, 460),
        headline(["service_name"], 52, 3, DARK, 460), subline(["tagline", "claim"], 24, 3, DARK, 440), cta(c, DARK, 460)], "center"),
      ...footer(c),
    ] };
  }
  return { mode: "seasonal", ground: "charcoal", labels: SEASONS, groups: [{ slot: "photos", min: 2, max: 2, require_service_match: true }], elements: [
    stack(72, 80, 936, 560, 20, [eyebrow(c, ["template_label"], true, DARK, 936),
      headline(["service_name"], 76, 2, DARK, 936), subline(["tagline", "claim"], 30, 2, DARK, 900), cta(c, DARK, 936)], "center"),
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 0, y: 600, w: 538, h: 586 },
    { type: "photo", slot: "photos", index: 1, role: "cell", x: 542, y: 600, w: 538, h: 586 },
    { type: "rect", x: 0, y: 596, w: 1080, h: 4, fill: "blue" },
    ...footer(c),
  ] };
}

const OUR_WORK: Label[] = [{ id: "our_work", text: "Our work", requires: "all_photos_own_work" }];

function realWork(c: Channel): Built {
  // The client's own jobs dominate; one label, the service, the CTA. No
  // project location: none is governed on the photos.
  if (c === "google_business") {
    return { ground: "charcoal", labels: OUR_WORK, groups: [{ slot: "photos", min: 3, max: 3, require_service_match: true }], elements: [
      { type: "photo", slot: "photos", index: 0, role: "cell", x: 0, y: 0, w: 398, h: 600 },
      { type: "photo", slot: "photos", index: 1, role: "cell", x: 401, y: 0, w: 398, h: 600 },
      { type: "photo", slot: "photos", index: 2, role: "cell", x: 802, y: 0, w: 398, h: 600 },
      { type: "rect", x: 0, y: 600, w: 1200, h: 4, fill: "blue" },
      stack(150, 616, 500, 768, 8, [eyebrow(c, ["template_label"], true, DARK, 500), headline(["service_name"], 40, 1, DARK, 500)], "center"),
      { ...cta(c, DARK, 380, "right"), x: 670, y: 662 },
      ...footer(c),
    ] };
  }
  return { ground: "charcoal", labels: OUR_WORK, groups: [{ slot: "photos", min: 4, max: 4, require_service_match: true }], elements: [
    { type: "photo", slot: "photos", index: 0, role: "cell", x: 0, y: 0, w: 537, h: 450 },
    { type: "photo", slot: "photos", index: 1, role: "cell", x: 543, y: 0, w: 537, h: 450 },
    { type: "photo", slot: "photos", index: 2, role: "cell", x: 0, y: 456, w: 537, h: 450 },
    { type: "photo", slot: "photos", index: 3, role: "cell", x: 543, y: 456, w: 537, h: 450 },
    { type: "rect", x: 0, y: 906, w: 1080, h: 6, fill: "blue" },
    stack(72, 950, 936, 1176, 18, [eyebrow(c, ["template_label"], true, DARK, 936), headline(["service_name"], 64, 1, DARK, 936), cta(c, DARK, 936)], "center"),
    ...footer(c),
  ] };
}

function serviceLight(c: Channel): Built {
  // The lighter alternative: light ground, charcoal type, rounded photos; the
  // footer band stays charcoal so the white wordmark keeps its ground.
  if (c === "google_business") {
    return { ground: "text", labels: [], groups: [{ slot: "photos", min: 3, max: 3, require_service_match: true }], elements: [
      { type: "photo", slot: "photos", index: 0, role: "hero", x: 620, y: 40, w: 530, h: 452, radius: 20 },
      { type: "photo", slot: "photos", index: 1, role: "cell", x: 620, y: 504, w: 261, h: 244, radius: 16 },
      { type: "photo", slot: "photos", index: 2, role: "cell", x: 889, y: 504, w: 261, h: 244, radius: 16 },
      stack(150, 88, 440, 752, 22, [eyebrow(c, ["service_segment", "business_name"], false, LIGHT, 440),
        headline(["service_name"], 52, 3, LIGHT, 440), subline(["tagline", "claim"], 24, 3, LIGHT, 430), cta(c, LIGHT, 440)], "center"),
      ...footer(c),
    ] };
  }
  return { ground: "text", labels: [], groups: [{ slot: "photos", min: 3, max: 3, require_service_match: true }], elements: [
    stack(72, 72, 936, 470, 20, [eyebrow(c, ["service_segment", "business_name"], false, LIGHT, 936),
      headline(["service_name"], 76, 2, LIGHT, 936), subline(["tagline", "claim"], 30, 1, LIGHT, 936), cta(c, LIGHT, 936)], "center"),
    { type: "photo", slot: "photos", index: 0, role: "hero", x: 72, y: 498, w: 936, h: 440, radius: 24 },
    { type: "photo", slot: "photos", index: 1, role: "cell", x: 72, y: 952, w: 461, h: 236, radius: 20 },
    { type: "photo", slot: "photos", index: 2, role: "cell", x: 547, y: 952, w: 461, h: 236, radius: 20 },
    ...footer(c),
  ] };
}

const BUILDERS: Record<Family, (c: Channel) => Built> = {
  service_spotlight: serviceSpotlight, trust_know_how: trustKnowHow, seasonal, real_work: realWork, service_light: serviceLight,
};

export function buildSpec(family: Family, channel: Channel, kit: BrandKit): TemplateSpec {
  const g = geo(channel);
  const b = BUILDERS[family](channel);
  return {
    schema: SPEC_SCHEMA,
    family,
    ...(b.mode ? { mode: b.mode } : {}),
    channel,
    canvas: { width: g.W, height: g.H, background: b.ground },
    safe_area: channel === "google_business" ? { x: 150, y: 0, w: 900, h: 900 } : { x: 72, y: 0, w: 936, h: 1350 },
    palette: kit.palette,
    fonts: kit.fonts,
    photo_groups: b.groups,
    labels: b.labels,
    blocked_phrases: kit.blocked_phrases,
    logo_asset_id: kit.logo_asset_id,
    elements: b.elements,
  };
}
