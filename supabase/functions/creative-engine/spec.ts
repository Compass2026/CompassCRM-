// Creative Engine template specs: types, canonical text and hashes.
//
// A spec is Compass's fixed design structure for one family on one channel
// (canvas, palette, typography, geometry, the slots it accepts and the roles
// each slot may draw from). It never holds a client fact or a claim: every
// word on a render comes from the governed record (govern.ts). The spec is
// registered through creative_register_template (0054), which stores its
// hash as creative_spec_hash(spec) = sha256 of the jsonb text; specHash()
// reproduces that text byte for byte (tests/creative-spec.test.mjs, and the
// sandbox compares against Postgres itself).

export const SPEC_SCHEMA = "compass-creative-spec/1";

export type Channel = "google_business" | "facebook" | "instagram";
export type Family = "service_spotlight" | "trust_know_how" | "seasonal" | "real_work" | "service_light";
export type ColorToken = "charcoal" | "panel" | "blue" | "sky" | "text" | "muted";
export type FontId = "montserrat-700" | "montserrat-800" | "poppins-500" | "poppins-600";

// Governed sources a text slot may draw from (0054's overlay roles, and the
// ones 0057 adds). Text is always resolved from the record, never passed in.
export type Role =
  | "business_name" | "service_name" | "service_segment" | "tagline" | "standing_cta"
  | "claim" | "phone" | "website" | "template_label";

export type TextStyle = {
  font: FontId;
  size: number;            // px; fixed — copy that does not fit is refused, never shrunk
  line_height: number;     // px
  color: ColorToken;
  tracking?: number;       // px between glyphs
  transform?: "uppercase";
  align?: "left" | "right" | "center";
};

export type TextSlot = {
  type: "text";
  slot: string;
  roles: Role[];
  required: boolean;
  auto?: Role;             // bound by the engine, never by the caller (footer, CTA)
  style: TextStyle;
  max_lines: number;
  max_words: number;
  w: number;
  background: ColorToken;  // the solid colour behind the text (contrast is linted)
};

export type PillSlot = {
  type: "pill";
  slot: string;
  roles: Role[];
  required: boolean;
  auto?: Role;
  style: TextStyle;
  fill: ColorToken;
  pad_x: number;
  pad_y: number;
  max_words: number;
  max_w: number;
  align?: "left" | "right";
  background: ColorToken;
};

export type ListSlot = {
  type: "list";
  slot: string;
  roles: Role[];
  required: boolean;
  min_items: number;
  max_items: number;
  max_words_each: number;
  max_lines_each: number;
  style: TextStyle;
  icon: { size: number; color: ColorToken; gap: number };
  item_gap: number;
  w: number;
  background: ColorToken;
};

export type StackItem = TextSlot | PillSlot | ListSlot;

export type Stack = {
  type: "stack";
  x: number;
  y: number;
  w: number;
  max_bottom: number;       // copy that runs past this is refused
  gap: number;
  anchor?: "top" | "center" | "bottom";  // where the measured block sits in [y, max_bottom]
  items: StackItem[];
};

export type Rect = { type: "rect"; x: number; y: number; w: number; h: number; fill: ColorToken; radius?: number };

// "hero": the photo carries the composition — needs an approved photo whose
// short side meets the quality gate. Every photo slot refuses upscaling.
export type PhotoRole = "hero" | "feature" | "cell";
export type PhotoSlot = {
  type: "photo";
  slot: string;              // photos[slot][index] when part of a group
  index: number;
  role: PhotoRole;
  x: number; y: number; w: number; h: number;
  radius?: number;
  keyline?: { color: ColorToken; width: number };
};

export type LogoTile = {
  type: "logo";
  x: number; y: number; w: number; h: number;
  fill: ColorToken;
  keyline: { color: ColorToken; width: number };
  radius: number;
  pad: number;
};

export type Placed = TextSlot & { x: number; y: number };
export type PlacedPill = PillSlot & { x: number; y: number };

export type Element = Rect | PhotoSlot | LogoTile | Stack | Placed | PlacedPill;

export type PhotoGroup = { slot: string; min: number; max: number; require_service_match: boolean };

export type Label = { id: string; text: string; requires?: "all_photos_own_work" };

export type TemplateSpec = {
  schema: typeof SPEC_SCHEMA;
  family: Family;
  mode?: string;
  channel: Channel;
  canvas: { width: number; height: number; background: ColorToken };
  safe_area: { x: number; y: number; w: number; h: number };
  palette: Record<ColorToken, string>;
  fonts: Record<FontId, { family: string; weight: number; sha256: string }>;
  photo_groups: PhotoGroup[];
  labels: Label[];
  blocked_phrases: string[];     // client-level: regex sources, case-insensitive
  logo_asset_id: string;         // the approved primary logo this client's templates carry
  elements: Element[];
};

export type RegisteredTemplate = {
  key: string;
  version: number;
  channel: Channel;
  name: string;
  description: string;
  output_width: number;
  output_height: number;
  mime_type: "image/png";
  spec: TemplateSpec;
};

// Postgres jsonb's text form: object keys ordered by length, then bytes;
// ", " and ": " separators. creative_spec_hash() hashes exactly this.
export function jsonbText(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("jsonbText: non-finite number");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "[" + v.map(jsonbText).join(", ") + "]";
  if (typeof v === "object") {
    const enc = new TextEncoder();
    const keys = Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] !== undefined);
    keys.sort((a, b) => {
      const ea = enc.encode(a), eb = enc.encode(b);
      if (ea.length !== eb.length) return ea.length - eb.length;
      for (let i = 0; i < ea.length; i++) if (ea[i] !== eb[i]) return ea[i] - eb[i];
      return 0;
    });
    return "{" + keys.map((k) => JSON.stringify(k) + ": " + jsonbText((v as Record<string, unknown>)[k])).join(", ") + "}";
  }
  throw new Error(`jsonbText: unsupported ${typeof v}`);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// creative_spec_hash(jsonb): 'sha256:' || sha256(jsonb::text).
export async function specHash(v: unknown): Promise<string> {
  return "sha256:" + await sha256Hex(jsonbText(v));
}

// WCAG 2 contrast ratio between two #rrggbb colours.
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Large text (≥ 24 px, or ≥ 18.66 px bold) needs 3:1; everything else 4.5:1.
export function contrastRequired(style: TextStyle): number {
  const bold = style.font.startsWith("montserrat") || style.font === "poppins-600";
  return style.size >= 24 || (bold && style.size >= 18.66) ? 3 : 4.5;
}

// Structural problems in a spec: colours outside the palette, text
// contrast, geometry outside the canvas, text outside the safe area.
export function lintSpec(spec: TemplateSpec): string[] {
  const out: string[] = [];
  const { width: W, height: H } = spec.canvas;
  const hex = (t: ColorToken) => spec.palette[t];
  const inCanvas = (x: number, y: number, w: number, h: number) => x >= 0 && y >= 0 && x + w <= W && y + h <= H;
  const sa = spec.safe_area;
  const inSafe = (x: number, w: number) => x >= sa.x && x + w <= sa.x + sa.w;
  const checkText = (name: string, style: TextStyle, bg: ColorToken) => {
    if (!hex(style.color) || !hex(bg)) out.push(`${name}: colour outside the palette`);
    else if (contrast(hex(style.color), hex(bg)) < contrastRequired(style)) {
      out.push(`${name}: contrast ${contrast(hex(style.color), hex(bg)).toFixed(2)} below ${contrastRequired(style)}`);
    }
    if (!spec.fonts[style.font]) out.push(`${name}: font ${style.font} not in the spec`);
  };
  for (const e of spec.elements) {
    if (e.type === "rect" || e.type === "photo" || e.type === "logo") {
      if (!inCanvas(e.x, e.y, e.w, e.h)) out.push(`${e.type} at ${e.x},${e.y} leaves the canvas`);
    }
    if (e.type === "logo" && !inSafe(e.x, e.w)) out.push("logo outside the safe area");
    if (e.type === "stack") {
      if (!inSafe(e.x, e.w)) out.push("text stack outside the safe area");
      if (e.max_bottom > sa.y + sa.h) out.push("text stack runs below the safe area");
      for (const it of e.items) {
        if (it.type === "pill") {
          checkText(it.slot, it.style, it.fill);
          if (hex(it.fill) && hex(it.background) && contrast(hex(it.fill), hex(it.background)) < 1.5) {
            out.push(`${it.slot}: pill does not stand out from its background`);
          }
        } else {
          checkText(it.slot, it.style, it.background);
          if (it.type === "list" && !hex(it.icon.color)) out.push(`${it.slot}: icon colour outside the palette`);
        }
      }
    }
    if (e.type === "text" || e.type === "pill") {
      const w = e.type === "text" ? e.w : e.max_w;
      if (!inSafe(e.x, w)) out.push(`${e.slot} outside the safe area`);
      if (e.y < sa.y || e.y + e.style.line_height * (e.type === "text" ? e.max_lines : 1) > sa.y + sa.h) {
        out.push(`${e.slot} outside the safe area`);
      }
      checkText(e.slot, e.style, e.type === "pill" ? e.fill : e.background);
    }
  }
  return out;
}
